import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/index.ts';
import { listMigrations, migrate } from '../src/db/migrate.ts';

const PLAN_TABLES = [
  'users',
  'sessions',
  'invites',
  'instance_settings',
  'sources',
  'profiles',
  'profile_sources',
  'bookmarks',
  'games',
  'player_games',
  'positions',
  'players_cache',
  'databases',
  'files',
  'jobs',
  'http_cache',
  'prep_sets',
  'prep_opponents',
];

describe('migrations', () => {
  let dir: string;
  let db: Db;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'outpost-db-'));
    db = openDb(join(dir, 'outpost.db'));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('applies 001_init on a fresh database and records it', () => {
    const { applied, current } = migrate(db);
    expect(applied.map(m => m.version)).toContain(1);
    expect(current).toBeGreaterThanOrEqual(1);
    const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").map(r => r.name);
    for (const t of PLAN_TABLES) expect(tables, t).toContain(t);
    expect(db.all('SELECT version FROM schema_migrations')).toHaveLength(applied.length);
  });

  it('is idempotent', () => {
    migrate(db);
    expect(migrate(db).applied).toEqual([]);
  });

  it('uses WAL and enforces foreign keys', () => {
    migrate(db);
    expect(db.value('PRAGMA journal_mode')).toBe('wal');
    expect(db.value('PRAGMA foreign_keys')).toBe(1);
    expect(() =>
      db.run('INSERT INTO sessions (id_hash, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)', [
        'x',
        999,
        1,
        2,
        1,
      ]),
    ).toThrow(/FOREIGN KEY/);
  });

  it('enforces the PLAN §4 value domains', () => {
    migrate(db);
    expect(() =>
      db.run(
        `INSERT INTO games (origin, origin_id, white, black, white_key, black_key, result, ply_count, moves_san)
         VALUES ('lichess', 'abc', 'A', 'B', 'a', 'b', '2-0', 0, '')`,
      ),
    ).toThrow(/CHECK/);
    db.run(
      `INSERT INTO games (origin, origin_id, white, black, white_key, black_key, result, ply_count, moves_san, ended_at)
       VALUES ('lichess', 'abc', 'A', 'B', 'a', 'b', '1-0', 0, '', 1)`,
    );
    expect(() =>
      db.run(
        `INSERT INTO games (origin, origin_id, white, black, white_key, black_key, result, ply_count, moves_san)
         VALUES ('lichess', 'abc', 'A', 'B', 'a', 'b', '1-0', 0, '')`,
      ),
    ).toThrow(/UNIQUE/);
  });

  it('keeps one active job per dedupe key', () => {
    migrate(db);
    const ins = (status: string) =>
      db.run("INSERT INTO jobs (kind, lane, status, created_at, dedupe_key) VALUES ('sync', 'lichess', ?, 1, 'sync:1')", [status]);
    ins('done');
    ins('queued');
    expect(() => ins('running')).toThrow(/UNIQUE/);
  });

  it('rejects bad file names and duplicate versions', () => {
    const mdir = mkdtempSync(join(tmpdir(), 'outpost-mig-'));
    try {
      writeFileSync(join(mdir, '001_a.sql'), 'CREATE TABLE a (x INTEGER);');
      writeFileSync(join(mdir, '010_b.sql'), 'CREATE TABLE b (x INTEGER);');
      expect(listMigrations(mdir).map(m => m.version)).toEqual([1, 10]);
      writeFileSync(join(mdir, '10_c.sql'), '');
      expect(() => listMigrations(mdir)).toThrow(/Bad migration file name/);
      rmSync(join(mdir, '10_c.sql'));
      writeFileSync(join(mdir, '010_c.sql'), '');
      expect(() => listMigrations(mdir)).toThrow(/Duplicate migration version 10/);
    } finally {
      rmSync(mdir, { recursive: true, force: true });
    }
  });

  it('rolls back a failing migration', () => {
    const mdir = mkdtempSync(join(tmpdir(), 'outpost-mig-'));
    try {
      writeFileSync(join(mdir, '001_ok.sql'), 'CREATE TABLE ok (x INTEGER);');
      writeFileSync(join(mdir, '002_bad.sql'), 'CREATE TABLE half (x INTEGER); INSERT INTO nope VALUES (1);');
      expect(() => migrate(db, { dir: mdir })).toThrow(/002_bad/);
      const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").map(r => r.name);
      expect(tables).toContain('ok');
      expect(tables).not.toContain('half');
    } finally {
      rmSync(mdir, { recursive: true, force: true });
    }
  });
});

describe('Db helpers', () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(':memory:');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT, flag INTEGER) STRICT');
  });
  afterEach(() => db.close());

  it('binds positional, named and boolean parameters', () => {
    const r = db.run('INSERT INTO t (v, flag) VALUES (?, ?)', ['a', true]);
    expect(r).toEqual({ changes: 1, lastInsertRowid: 1 });
    db.run('INSERT INTO t (v, flag) VALUES (:v, :flag)', { v: 'b', flag: false });
    expect(db.all('SELECT v, flag FROM t ORDER BY id')).toEqual([
      { v: 'a', flag: 1 },
      { v: 'b', flag: 0 },
    ]);
    expect(db.value('SELECT COUNT(*) FROM t')).toBe(2);
    expect(db.get('SELECT * FROM t WHERE id = ?', [99])).toBeUndefined();
  });

  it('commits and rolls back transactions, with nested savepoints', () => {
    db.tx(() => db.run("INSERT INTO t (v) VALUES ('a')"));
    expect(() =>
      db.tx(() => {
        db.run("INSERT INTO t (v) VALUES ('b')");
        throw new Error('boom');
      }),
    ).toThrow('boom');
    db.tx(() => {
      db.run("INSERT INTO t (v) VALUES ('c')");
      expect(() =>
        db.tx(() => {
          db.run("INSERT INTO t (v) VALUES ('d')");
          throw new Error('inner');
        }),
      ).toThrow('inner');
    });
    expect(db.all<{ v: string }>('SELECT v FROM t ORDER BY id').map(r => r.v)).toEqual(['a', 'c']);
    expect(db.inTransaction).toBe(false);
  });

  it('refuses async transaction callbacks', () => {
    expect(() => db.tx(async () => db.run("INSERT INTO t (v) VALUES ('x')"))).toThrow(/synchronous/);
    expect(db.value('SELECT COUNT(*) FROM t')).toBe(0);
  });
});
