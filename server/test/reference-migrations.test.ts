import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { insertGame } from '../src/chess/index.ts';
import { openDb, type Db } from '../src/db/index.ts';
import { migrate, MIGRATIONS_DIR } from '../src/db/migrate.ts';
import { createSource, testGame } from './helpers.ts';

/** A database migrated up to (and including) `upTo`, from a copy of the migration files. */
function migratedUpTo(upTo: number): { db: Db; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'outpost-mig-'));
  for (const f of readdirSync(MIGRATIONS_DIR)) {
    if (f.endsWith('.sql') && Number(f.slice(0, 3)) <= upTo) copyFileSync(join(MIGRATIONS_DIR, f), join(dir, f));
  }
  const db = openDb(':memory:');
  migrate(db, { dir });
  return { db, dir };
}

describe('migration 601 (FIDE sources: reference games only, one copy each)', () => {
  const cleanup: Array<() => void> = [];
  afterEach(() => {
    for (const f of cleanup.splice(0)) f();
  });

  it('drops FIDE rows of user-database games and of second copies, then guards new inserts', () => {
    const { db, dir } = migratedUpTo(600);
    cleanup.push(() => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const userDb = db.run("INSERT INTO databases (name, kind, visibility, created_at) VALUES ('Prep', 'games', 'private', 0)").lastInsertRowid;
    const refA = db.run("INSERT INTO databases (name, kind, visibility, created_at) VALUES ('Broadcasts', 'reference', 'public', 0)").lastInsertRowid;
    const refB = db.run("INSERT INTO databases (name, kind, visibility, created_at) VALUES ('OTB', 'reference', 'public', 0)").lastInsertRowid;
    const fide = createSource(db, { kind: 'fide', key: '1503014' });
    const carlsen = { name: 'Carlsen, Magnus', fideId: '1503014' };
    // Rows as an earlier insertGame wrote them: the FIDE source on a user-database game (insertGame
    // itself links reference games only) and, with no trigger before 601, on both reference copies.
    const legacy = (gameId: number) =>
      db.run(
        `INSERT INTO player_games (source_id, game_id, color, outcome, opp_name, opp_key, opp_source_kind, ended_at, time_class, rated)
         SELECT ?, id, 'w', 'w', black, black_key, 'pgn', ended_at, time_class, rated FROM games WHERE id = ?`,
        [fide, gameId],
      );
    const u = insertGame(db, testGame({ origin: 'pgn', originId: `${userDb}:h1`, databaseId: userDb, white: carlsen }));
    expect(u.sourceIds).toEqual([]);
    legacy(u.gameId);
    const a = insertGame(db, testGame({ origin: 'reference', originId: `${refA}:h2`, databaseId: refA, white: carlsen })).gameId;
    expect(insertGame(db, testGame({ origin: 'reference', originId: `${refB}:h2`, databaseId: refB, white: carlsen })).sourceIds).toEqual([fide]);
    expect(db.value('SELECT COUNT(*) FROM player_games WHERE source_id = ?', [fide])).toBe(3);

    migrate(db); // applies 601
    expect(db.all('SELECT game_id FROM player_games WHERE source_id = ?', [fide])).toEqual([{ game_id: a }]);
    expect(db.value('SELECT rank FROM reference_broadcast_games LIMIT 1')).toBeUndefined();
    expect(db.value("SELECT COUNT(*) FROM pragma_table_info('reference_broadcast_games') WHERE name = 'rank'")).toBe(1);
    expect(db.value("SELECT COUNT(*) FROM sqlite_master WHERE name = 'reference_broadcast_tours'")).toBe(1);

    // New rows follow the same rules; other sources are untouched.
    const u2 = insertGame(db, testGame({ origin: 'pgn', originId: `${userDb}:h3`, databaseId: userDb, white: carlsen })).gameId;
    expect(insertGame(db, testGame({ origin: 'reference', originId: `${refB}:h4`, databaseId: refB, white: carlsen })).sourceIds).toEqual([fide]);
    // The second copy is skipped by the trigger, and insertGame does not report it.
    expect(insertGame(db, testGame({ origin: 'reference', originId: `${refA}:h4`, databaseId: refA, white: carlsen })).sourceIds).toEqual([]);
    expect(db.value('SELECT COUNT(*) FROM player_games WHERE source_id = ?', [fide])).toBe(2);
    // Any other writer is held to the rule too.
    legacy(u2);
    expect(db.value('SELECT COUNT(*) FROM player_games WHERE source_id = ?', [fide])).toBe(2);
    const lichess = createSource(db, { kind: 'lichess', key: 'alice' });
    insertGame(db, testGame({}));
    expect(db.value('SELECT COUNT(*) FROM player_games WHERE source_id = ?', [lichess])).toBe(1);
  });
});

describe('migration 602 (FIDE sources: public reference databases only)', () => {
  const cleanup: Array<() => void> = [];
  afterEach(() => {
    for (const f of cleanup.splice(0)) f();
  });

  it('drops FIDE rows of private reference databases, guards new inserts and relinks on a visibility change', async () => {
    const { db, dir } = migratedUpTo(601);
    cleanup.push(() => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const { relinkFideSources } = await import('../src/chess/index.ts');
    const pub = db.run("INSERT INTO databases (name, kind, visibility, created_at) VALUES ('Broadcasts', 'reference', 'public', 0)").lastInsertRowid;
    const licensed = db.run("INSERT INTO databases (name, kind, visibility, created_at) VALUES ('Licensed', 'reference', 'private', 0)").lastInsertRowid;
    const fide = createSource(db, { kind: 'fide', key: '1503014' });
    const carlsen = { name: 'Carlsen, Magnus', fideId: '1503014' };
    // Before 602 a private reference database fed FIDE players like any other.
    const own = insertGame(db, testGame({ origin: 'reference', originId: `${licensed}:only`, databaseId: licensed, white: carlsen })).gameId;
    const first = insertGame(db, testGame({ origin: 'reference', originId: `${licensed}:both`, databaseId: licensed, white: carlsen })).gameId;
    const copy = insertGame(db, testGame({ origin: 'reference', originId: `${pub}:both`, databaseId: pub, white: carlsen })).gameId;
    const linked = () => db.all<{ game_id: number }>('SELECT game_id FROM player_games WHERE source_id = ? ORDER BY game_id', [fide]).map(r => r.game_id);
    expect(linked()).toEqual([own, first]);

    migrate(db); // applies 602
    expect(linked()).toEqual([]);
    // The public copy comes back with a relink (as after a visibility change).
    expect(relinkFideSources(db, licensed)).toBe(1);
    expect(linked()).toEqual([copy]);
    // New games of the private database are never linked.
    insertGame(db, testGame({ origin: 'reference', originId: `${licensed}:new`, databaseId: licensed, white: carlsen }));
    expect(linked()).toEqual([copy]);

    // Made public: its games join (one copy per game), and back again when private.
    db.run("UPDATE databases SET visibility = 'public' WHERE id = ?", [licensed]);
    relinkFideSources(db, licensed);
    expect(linked()).toHaveLength(3);
    expect(linked()).toContain(copy);
    db.run("UPDATE databases SET visibility = 'private' WHERE id = ?", [licensed]);
    relinkFideSources(db, licensed);
    expect(linked()).toEqual([copy]);
  });
});
