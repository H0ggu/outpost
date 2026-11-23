import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { insertGame } from '../src/chess/store.ts';
import { openDb, type Db } from '../src/db/index.ts';
import { migrate, MIGRATIONS_DIR } from '../src/db/migrate.ts';
import { testGame } from './helpers.ts';

/** The profiles module's migrations applied to a database that already holds data. */
describe('profiles migrations on existing data', () => {
  let dir: string;
  let db: Db;

  /** Migrates a fresh database with the given migration files only. */
  const migrateWith = (files: string[]): void => {
    for (const f of files) copyFileSync(join(MIGRATIONS_DIR, f), join(dir, f));
    migrate(db, { dir });
  };

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('501 keeps every source and its references; 503 sizes files', () => {
    dir = mkdtempSync(join(tmpdir(), 'outpost-mig-'));
    db = openDb(':memory:');
    // 202 because insertGame writes today's player_games columns.
    migrateWith(['001_init.sql', '202_player_games_rating_pool.sql', '500_databases_files.sql']);

    const user = db.run("INSERT INTO users (username, password_hash, created_at) VALUES ('u', 'x', 0)").lastInsertRowid;
    const userDb = db.run("INSERT INTO databases (owner_user_id, name, kind, created_at) VALUES (?, 'Mine', 'games', 0)", [user]).lastInsertRowid;
    const refDb = db.run("INSERT INTO databases (name, kind, visibility, created_at) VALUES ('Ref', 'reference', 'public', 0)").lastInsertRowid;
    const src = (kind: string, key: string, databaseId: number | null = null) =>
      db.run('INSERT INTO sources (kind, key, display_name, database_id, sync_state_json, created_at) VALUES (?, ?, ?, ?, ?, 7)', [
        kind,
        key,
        key.toUpperCase(),
        databaseId,
        '{"since":1}',
      ]).lastInsertRowid;
    const fide = src('fide', '5000005');
    const pgn = src('pgn', `${userDb}:pat`, userDb);
    const gone = src('lichess', 'gone');
    db.run('DELETE FROM sources WHERE id = ?', [gone]);
    const lichess = src('lichess', 'lin');
    const profile = db.run("INSERT INTO profiles (slug, display_name, created_at, updated_at) VALUES ('p', 'P', 0, 0)").lastInsertRowid;
    for (const s of [fide, pgn, lichess]) db.run('INSERT INTO profile_sources (profile_id, source_id) VALUES (?, ?)', [profile, s]);
    // The FIDE source links the reference game only (chess/store.ts; migration 601 guards it).
    const userGame = insertGame(
      db,
      testGame({ origin: 'pgn', originId: `${userDb}:g1`, databaseId: userDb, white: { name: 'Pat', fideId: '5000005' } }),
    );
    const refGame = insertGame(
      db,
      testGame({ origin: 'reference', originId: `${refDb}:g2`, databaseId: refDb, white: { name: 'Pat', fideId: '5000005' } }),
    );
    expect(userGame.sourceIds).toEqual([pgn]);
    expect(refGame.sourceIds).toEqual([fide]);
    db.run("INSERT INTO files (owner_user_id, name, kind, pgn, created_at, updated_at) VALUES (?, 'f', 'study', '1. e4 Ω', 0, 0)", [user]);

    migrateWith(['501_sources_autoincrement.sql', '503_files_quota.sql']);

    // 501: same rows, ids and columns; foreign keys intact; ids are never handed out twice.
    expect(db.all('SELECT id, kind, key, display_name, database_id, sync_state_json, created_at FROM sources ORDER BY id')).toEqual([
      { id: fide, kind: 'fide', key: '5000005', display_name: '5000005', database_id: null, sync_state_json: '{"since":1}', created_at: 7 },
      { id: pgn, kind: 'pgn', key: `${userDb}:pat`, display_name: `${userDb}:PAT`, database_id: userDb, sync_state_json: '{"since":1}', created_at: 7 },
      { id: lichess, kind: 'lichess', key: 'lin', display_name: 'LIN', database_id: null, sync_state_json: '{"since":1}', created_at: 7 },
    ]);
    expect(db.all('PRAGMA foreign_key_check')).toEqual([]);
    expect(db.value('SELECT COUNT(*) FROM profile_sources WHERE profile_id = ?', [profile])).toBe(3);
    db.run('DELETE FROM sources WHERE id = ?', [lichess]);
    expect(src('lichess', 'next')).toBeGreaterThan(lichess);
    // Cascades still work against the rebuilt table.
    expect(db.value('SELECT COUNT(*) FROM player_games WHERE source_id = ?', [pgn])).toBe(1);
    db.run('DELETE FROM sources WHERE id = ?', [pgn]);
    expect(db.value('SELECT COUNT(*) FROM player_games WHERE source_id = ?', [pgn])).toBe(0);

    // The FIDE source's rows survive the rebuild of `sources`.
    expect(db.all('SELECT game_id FROM player_games WHERE source_id = ?', [fide])).toEqual([{ game_id: refGame.gameId }]);

    // 503: existing files got their size (UTF-8 bytes).
    expect(db.value('SELECT pgn_bytes FROM files')).toBe(Buffer.byteLength('1. e4 Ω'));
  });
});
