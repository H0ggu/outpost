/**
 * The expensive row counts of `GET /api/admin/status` (games, reference games, positions).
 *
 * A reference database can hold millions of games and ~50 position rows per game, and a full
 * `COUNT(*)` over them takes seconds. node:sqlite is synchronous, so counting on the server's own
 * connection would freeze every request meanwhile. `countHeavyRowsInWorker` therefore counts in a
 * worker thread (src/auth/rowCounts.worker.ts) with its own read-only connection: in WAL mode a
 * reader never blocks the server's writes, and the event loop stays free.
 *
 * A database without a file (`:memory:`, tests) cannot be opened by a second connection; it is
 * counted inline by the caller (`canCountInWorker`).
 */
import { Worker } from 'node:worker_threads';
import type { Db } from '../db/index.ts';

/** The counts taken in the worker. */
export interface HeavyCounts {
  /** Games of Lichess / Chess.com sources and personal PGN databases. */
  games: number;
  /** Games in reference databases. */
  referenceGames: number;
  /** Rows of `positions` (one per ply up to 50, per game). */
  positions: number;
}

/** Message the worker posts back. */
export type CountsMessage = { ok: true; counts: HeavyCounts } | { ok: false; error: string };

/** Counts on `db` (synchronous: a worker thread, or a small in-memory database). */
export function countHeavyRows(db: Db): HeavyCounts {
  let games = 0;
  let referenceGames = 0;
  // One pass over the (origin, origin_id) unique index for both game counts.
  for (const r of db.all<{ origin: string; n: number }>('SELECT origin, COUNT(*) AS n FROM games GROUP BY origin')) {
    if (r.origin === 'reference') referenceGames += r.n;
    else games += r.n;
  }
  const positions = db.value<number>('SELECT COUNT(*) FROM positions') ?? 0;
  return { games, referenceGames, positions };
}

/** Whether a second connection (the worker's) can open the database at `path`. */
export const canCountInWorker = (path: string): boolean => path !== '' && path !== ':memory:' && !path.startsWith('file::memory:');

/**
 * Counts in a worker thread with its own read-only connection to `dbPath`. Rejects when the worker
 * fails or `signal` aborts (the worker is then terminated).
 */
export function countHeavyRowsInWorker(dbPath: string, opts: { signal?: AbortSignal } = {}): Promise<HeavyCounts> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(opts.signal.reason ?? new Error('aborted'));
      return;
    }
    const worker = new Worker(new URL('./rowCounts.worker.ts', import.meta.url), { workerData: { dbPath } });
    // Never keeps the process alive on its own.
    worker.unref();
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      opts.signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = (): void => {
      finish(() => reject(opts.signal?.reason ?? new Error('aborted')));
      void worker.terminate();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    worker.once('message', (msg: CountsMessage) => {
      finish(() => (msg.ok ? resolve(msg.counts) : reject(new Error(msg.error))));
    });
    worker.once('error', err => finish(() => reject(err)));
    worker.once('exit', code => finish(() => reject(new Error(`row count worker exited with code ${code}`))));
  });
}
