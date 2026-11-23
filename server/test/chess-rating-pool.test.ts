import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertGame, ratingPoolOf, rebuildPlayerGames } from '../src/chess/index.ts';
import { openDb } from '../src/db/index.ts';
import { migrate, MIGRATIONS_DIR } from '../src/db/migrate.ts';
import { currentRatings as profileRatings } from '../src/profiles/sources.ts';
import { currentRatings, ratingAverages, ratingSeries } from '../src/stats/index.ts';
import { mapLichessGame, type LichessGame } from '../src/sync/index.ts';
import { createSource, makeTestApp, testGame, type TestApp } from './helpers.ts';

/** A rated Lichess game of `me` (White) at `clock`, ending `at`, rating `rating` → `rating + diff`. */
const lichessGame = (id: string, speed: string, clock: { initial: number; increment: number }, at: number, rating: number, diff: number): LichessGame => ({
  id,
  rated: true,
  variant: 'standard',
  speed,
  status: 'resign',
  winner: 'white',
  createdAt: at - 60_000,
  lastMoveAt: at,
  clock: { ...clock, totalTime: clock.initial + 40 * clock.increment },
  moves: 'e4 e5 Nf3 Nc6',
  players: {
    white: { user: { id: 'me', name: 'Me' }, rating, ratingDiff: diff },
    black: { user: { id: 'opp', name: 'Opp' }, rating: rating - 100, ratingDiff: -diff },
  },
} as LichessGame);

describe('rating pools (Lichess UltraBullet is filed under bullet but rated apart)', () => {
  let t: TestApp;
  let me: number;
  beforeAll(async () => {
    t = await makeTestApp();
    me = createSource(t.db, { kind: 'lichess', key: 'me' });
    const day = (d: number) => Date.UTC(2026, 9, d, 12);
    for (const [id, speed, clock, at, rating, diff] of [
      ['b1', 'bullet', { initial: 60, increment: 0 }, day(1), 3250, 5],
      ['b2', 'bullet', { initial: 60, increment: 0 }, day(2), 3255, 8],
      ['u1', 'ultraBullet', { initial: 15, increment: 0 }, day(3), 2406, 5],
    ] as const) {
      const g = mapLichessGame(lichessGame(id, speed, clock, at, rating, diff));
      if ('skip' in g) throw new Error(g.skip);
      insertGame(t.db, g);
    }
  });
  afterAll(async () => t.close());

  it('names the pool of Lichess games under 30 s only', () => {
    const base = { origin: 'lichess', timeClass: 'bullet', url: null } as const;
    expect(ratingPoolOf({ ...base, timeControl: '15+0' })).toBe('ultraBullet');
    expect(ratingPoolOf({ ...base, timeControl: '0+1' })).toBeNull(); // 40 s estimated
    expect(ratingPoolOf({ ...base, timeControl: '30+0' })).toBeNull();
    expect(ratingPoolOf({ ...base, origin: 'chesscom', timeControl: '15' })).toBeNull();
    expect(ratingPoolOf({ ...base, origin: 'pgn', timeControl: '15+0', url: 'https://lichess.org/abcdefgh' })).toBe('ultraBullet');
    expect(ratingPoolOf({ ...base, origin: 'pgn', timeControl: '15+0' })).toBeNull();
    expect(t.db.all('SELECT rating_pool FROM player_games WHERE source_id = ? ORDER BY ended_at', [me])).toEqual([
      { rating_pool: null },
      { rating_pool: null },
      { rating_pool: 'ultraBullet' },
    ]);
  });

  it('keeps UltraBullet out of the bullet rating views, but counts the game', () => {
    const scope = { db: t.db, sourceIds: [me], filters: {} };
    expect(currentRatings(scope)).toEqual([{ sourceId: me, timeClass: 'bullet', rating: 3263 }]);
    expect(ratingSeries(scope)[0]!.points.map(p => p[1])).toEqual([3255, 3263]);
    const all = ratingAverages(scope).at(-1)!;
    expect(all).toMatchObject({ games: 3, avgRating: Math.round((3250 + 3255) / 2), score: 1 });
    expect(profileRatings(t.db, { id: me, kind: 'lichess', profile_json: null })).toEqual([
      { timeClass: 'bullet', rating: 3263, games: 3, rd: null, provisional: false },
    ]);
  });

  it('sets the pool on rows rebuilt from stored games', () => {
    t.db.run('DELETE FROM player_games WHERE source_id = ?', [me]);
    expect(rebuildPlayerGames(t.db, me)).toBe(3);
    expect(t.db.value("SELECT COUNT(*) FROM player_games WHERE source_id = ? AND rating_pool = 'ultraBullet'", [me])).toBe(1);
  });

  it('backfills stored rows (migration 202)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'outpost-mig-'));
    for (const f of readdirSync(MIGRATIONS_DIR)) if (f.endsWith('.sql') && Number(f.slice(0, 3)) < 200) copyFileSync(join(MIGRATIONS_DIR, f), join(dir, f));
    const db = openDb(':memory:');
    try {
      migrate(db, { dir });
      const src = createSource(db, { kind: 'lichess', key: 'me' });
      const add = (originId: string, timeControl: string, url: string | null, origin: 'lichess' | 'pgn' = 'lichess') => {
        const g = testGame({ originId, origin, timeControl, timeClass: 'bullet', url, white: { name: 'me' } });
        const id = db.run(
          `INSERT INTO games (origin, origin_id, url, white, black, white_key, black_key, result, termination, time_class, time_control, rated,
             started_at, ended_at, ply_count, moves_san)
           VALUES (?, ?, ?, 'me', 'opp', 'me', 'opp', '1-0', 'resign', 'bullet', ?, 1, 0, 0, 2, 'e4 e5')`,
          [g.origin, g.originId, g.url, g.timeControl],
        ).lastInsertRowid;
        db.run(
          `INSERT INTO player_games (source_id, game_id, color, outcome, opp_name, opp_key, opp_source_kind, ended_at, time_class, rated)
           VALUES (?, ?, 'w', 'w', 'opp', 'opp', 'lichess', 0, 'bullet', 1)`,
          [src, id],
        );
      };
      add('u', '15+0', null);
      add('b', '60+0', null);
      add('p', '15+0', 'https://lichess.org/abcdefgh', 'pgn');
      migrate(db);
      expect(db.all('SELECT rating_pool FROM player_games ORDER BY game_id')).toEqual([
        { rating_pool: 'ultraBullet' },
        { rating_pool: null },
        { rating_pool: 'ultraBullet' },
      ]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
