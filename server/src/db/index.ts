/**
 * SQLite access on `node:sqlite` (PLAN §1, §4).
 *
 * `Db` wraps one connection with cached prepared statements, typed helpers and `tx()`.
 * The API is synchronous: keep transactions short, and run heavy imports in a worker thread
 * with its own `openDb(config.dbPath)` connection (WAL allows concurrent readers).
 *
 * Conventions: times are epoch ms, booleans 0/1 (JS booleans bind as 0/1), JSON as TEXT.
 * Rows come back as null-prototype objects; BLOBs as Uint8Array.
 */
import { Database, type Statement } from 'node:sqlite';

/** A value that can be bound to a statement parameter. */
export type SqlValue = null | number | bigint | string | boolean | Uint8Array;
/** Positional (`?`) or named (`:name`, `$name`, `@name`; keys without the prefix) parameters. */
export type SqlParams = readonly SqlValue[] | Readonly<Record<string, SqlValue>>;
/** Result of `run()`. */
export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

/** Busy timeout for lock waits, ms. */
export const BUSY_TIMEOUT_MS = 5000;

const isThenable = (v: unknown): boolean =>
  typeof v === 'object' && v !== null && typeof (v as { then?: unknown }).then === 'function';

/** One SQLite connection. */
export class Db {
  /** The underlying `node:sqlite` connection, for features the helpers don't cover. */
  readonly raw: Database;
  readonly path: string;
  readonly #stmts = new Map<string, Statement>();
  #savepoint = 0;

  constructor(path: string, opts: { readOnly?: boolean } = {}) {
    this.path = path;
    this.raw = new Database(path, {
      readOnly: opts.readOnly ?? false,
      timeout: BUSY_TIMEOUT_MS,
      enableForeignKeyConstraints: true,
    });
    if (!opts.readOnly) this.raw.exec('PRAGMA journal_mode = WAL');
    this.raw.exec(`
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};
      PRAGMA temp_store = MEMORY;
      PRAGMA cache_size = -65536;
    `);
  }

  /** A cached prepared statement for `sql`. */
  prepare(sql: string): Statement {
    let s = this.#stmts.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.#stmts.set(sql, s);
    }
    return s;
  }

  /** First row, or undefined. */
  get<T extends object = Record<string, unknown>>(sql: string, params: SqlParams = []): T | undefined {
    return bind(this.prepare(sql), 'get', params) as T | undefined;
  }

  /** All rows. */
  all<T extends object = Record<string, unknown>>(sql: string, params: SqlParams = []): T[] {
    return bind(this.prepare(sql), 'all', params) as T[];
  }

  /** Lazily iterate rows (don't run other statements on the same SQL while iterating). */
  iterate<T extends object = Record<string, unknown>>(sql: string, params: SqlParams = []): IterableIterator<T> {
    return bind(this.prepare(sql), 'iterate', params) as IterableIterator<T>;
  }

  /** Single value of the first column of the first row. */
  value<T = unknown>(sql: string, params: SqlParams = []): T | undefined {
    const row = this.get<Record<string, unknown>>(sql, params);
    return row ? (Object.values(row)[0] as T) : undefined;
  }

  /** INSERT/UPDATE/DELETE. `lastInsertRowid` is a number (Outpost rowids stay below 2^53). */
  run(sql: string, params: SqlParams = []): RunResult {
    const r = bind(this.prepare(sql), 'run', params) as { changes: number | bigint; lastInsertRowid: number | bigint };
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  /** Executes one or more statements without parameters (DDL, PRAGMAs). */
  exec(sql: string): void {
    this.raw.exec(sql);
  }

  /** True inside a transaction. */
  get inTransaction(): boolean {
    return this.raw.isTransaction;
  }

  /**
   * Runs `fn` in a transaction (BEGIN IMMEDIATE … COMMIT, ROLLBACK on throw). Nested calls use
   * savepoints. `fn` must be synchronous: returning a Promise rolls back and throws.
   */
  tx<T>(fn: () => T): T {
    if (this.raw.isTransaction) {
      const name = `outpost_sp_${++this.#savepoint}`;
      this.raw.exec(`SAVEPOINT ${name}`);
      try {
        const r = fn();
        if (isThenable(r)) throw new TypeError('db.tx() callback must be synchronous');
        this.raw.exec(`RELEASE ${name}`);
        return r;
      } catch (e) {
        this.raw.exec(`ROLLBACK TO ${name}`);
        this.raw.exec(`RELEASE ${name}`);
        throw e;
      }
    }
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      if (isThenable(r)) throw new TypeError('db.tx() callback must be synchronous');
      this.raw.exec('COMMIT');
      return r;
    } catch (e) {
      if (this.raw.isTransaction) this.raw.exec('ROLLBACK');
      throw e;
    }
  }

  /** Runs `PRAGMA optimize` and closes the connection. */
  close(): void {
    if (!this.raw.isOpen) return;
    try {
      this.raw.exec('PRAGMA optimize');
    } catch {
      // read-only or busy: optimisation is best effort
    }
    this.#stmts.clear();
    this.raw.close();
  }
}

type Method = 'get' | 'all' | 'iterate' | 'run';

function bind(stmt: Statement, method: Method, params: SqlParams): unknown {
  // node:sqlite binds JS booleans as 0/1 and accepts Uint8Array for BLOBs.
  const fn = stmt[method] as (...args: unknown[]) => unknown;
  if (Array.isArray(params)) return fn.apply(stmt, params);
  return fn.call(stmt, params);
}

/** Opens (creating if needed) the database at `path` (`:memory:` for tests). */
export function openDb(path: string, opts: { readOnly?: boolean } = {}): Db {
  return new Db(path, opts);
}
