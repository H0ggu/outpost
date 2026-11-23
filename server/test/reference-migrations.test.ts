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

describe('migration 601 (reference FIDE dedupe)', () => {
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
    const refA = db.run("INSERT INTO databases (name, kind, created_at) VALUES ('Broadcasts', 'reference', 0)").lastInsertRowid;
    const refB = db.run("INSERT INTO databases (name, kind, created_at) VALUES ('OTB', 'reference', 0)").lastInsertRowid;
    const fide = createSource(db, { kind: 'fide', key: '1503014' });
    const carlsen = { name: 'Carlsen, Magnus', fideId: '1503014' };
    // Before 601 every one of these got a row for the FIDE source.
    insertGame(db, testGame({ origin: 'pgn', originId: `${userDb}:h1`, databaseId: userDb, white: carlsen }));
    const a = insertGame(db, testGame({ origin: 'reference', originId: `${refA}:h2`, databaseId: refA, white: carlsen })).gameId;
    insertGame(db, testGame({ origin: 'reference', originId: `${refB}:h2`, databaseId: refB, white: carlsen }));
    expect(db.value('SELECT COUNT(*) FROM player_games WHERE source_id = ?', [fide])).toBe(3);

    migrate(db); // applies 601
    expect(db.all('SELECT game_id FROM player_games WHERE source_id = ?', [fide])).toEqual([{ game_id: a }]);
    expect(db.value('SELECT rank FROM reference_broadcast_games LIMIT 1')).toBeUndefined();
    expect(db.value("SELECT COUNT(*) FROM pragma_table_info('reference_broadcast_games') WHERE name = 'rank'")).toBe(1);
    expect(db.value("SELECT COUNT(*) FROM sqlite_master WHERE name = 'reference_broadcast_tours'")).toBe(1);

    // New rows follow the same rules; other sources are untouched.
    insertGame(db, testGame({ origin: 'pgn', originId: `${userDb}:h3`, databaseId: userDb, white: carlsen }));
    insertGame(db, testGame({ origin: 'reference', originId: `${refB}:h4`, databaseId: refB, white: carlsen }));
    insertGame(db, testGame({ origin: 'reference', originId: `${refA}:h4`, databaseId: refA, white: carlsen }));
    expect(db.value('SELECT COUNT(*) FROM player_games WHERE source_id = ?', [fide])).toBe(2);
    const lichess = createSource(db, { kind: 'lichess', key: 'alice' });
    insertGame(db, testGame({}));
    expect(db.value('SELECT COUNT(*) FROM player_games WHERE source_id = ?', [lichess])).toBe(1);
  });
});
