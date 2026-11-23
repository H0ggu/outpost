import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/index.ts';
import { migrate, MIGRATIONS_DIR } from '../src/db/migrate.ts';

/** A database migrated with the migrations below `below`, from a copy of the migration files. */
function migratedBelow(below: number): { db: Db; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'outpost-mig-'));
  for (const f of readdirSync(MIGRATIONS_DIR)) if (f.endsWith('.sql') && Number(f.slice(0, 3)) < below) copyFileSync(join(MIGRATIONS_DIR, f), join(dir, f));
  const db = openDb(':memory:');
  migrate(db, { dir });
  return { db, dir };
}

describe('migration 204 (Chess.com game rows keep the ratings Chess.com reports)', () => {
  const cleanup: Array<() => void> = [];
  afterEach(() => {
    for (const f of cleanup.splice(0)) f();
  });

  it("takes both sides' ratings from the stored PGN tags of Chess.com games only", () => {
    const { db, dir } = migratedBelow(204);
    cleanup.push(() => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const add = (origin: string, white: number, black: number, headers: Record<string, string> | null) =>
      db.run(
        `INSERT INTO games (origin, origin_id, white, black, white_key, black_key, white_rating, black_rating, result, termination,
           time_class, rated, ply_count, moves_san, headers_json)
         VALUES (?, ?, 'Hikaru', 'Opp', 'hikaru', 'opp', ?, ?, '1-0', 'resign', 'blitz', 1, 2, 'e4 e5', ?)`,
        [origin, `${origin}-${white}`, white, black, headers ? JSON.stringify(headers) : null],
      ).lastInsertRowid;
    const cc = add('chesscom', 3464, 2867, { WhiteElo: '3465', BlackElo: '2867' });
    const odd = add('chesscom', 3000, 2000, { WhiteElo: '?', BlackElo: '2001' });
    const li = add('lichess', 2100, 2200, { WhiteElo: '2108', BlackElo: '2192' });
    migrate(db);
    const ratings = (id: number) => db.get('SELECT white_rating, black_rating FROM games WHERE id = ?', [id]);
    expect(ratings(cc)).toEqual({ white_rating: 3465, black_rating: 2867 });
    expect(ratings(odd)).toEqual({ white_rating: 3000, black_rating: 2001 });
    expect(ratings(li)).toEqual({ white_rating: 2100, black_rating: 2200 });
    expect(db.value("SELECT COUNT(*) FROM pragma_table_info('games') WHERE name = 'clocks'")).toBe(1);
  });
});
