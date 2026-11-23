import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OPENINGS_RANK_MIN_GAMES, type Outcome, type TimeClass } from '@outpost/shared/api';
import { insertGame } from '../src/chess/store.ts';
import {
  normalizeCountry,
  openingsStats,
  opponentsPage,
  ratingAverages,
  ratingSeries,
  type StatsScope,
} from '../src/stats/index.ts';
import { lttb } from '../src/stats/rating.ts';
import { createSource, makeTestApp, testGame, type TestApp } from './helpers.ts';
import { NAJDORF, QGD, RUY } from './stats-fixtures.ts';

const DAY = 86_400_000;
const T0 = Date.UTC(2024, 0, 1, 12);

describe('openings ranking', () => {
  let t: TestApp;
  let scope: StatsScope;

  beforeAll(async () => {
    t = await makeTestApp();
    const me = createSource(t.db, { kind: 'lichess', key: 'me' });
    scope = { db: t.db, sourceIds: [me], filters: {} };
    let n = 0;
    const play = (moves: string[], outcomes: Outcome[], color: 'white' | 'black' = 'white') => {
      for (const o of outcomes) {
        const won = o === 'w';
        const result = o === 'd' ? '1/2-1/2' : won === (color === 'white') ? '1-0' : '0-1';
        insertGame(
          t.db,
          testGame({
            endedAt: T0 + n++ * DAY,
            white: { name: color === 'white' ? 'me' : 'opp' },
            black: { name: color === 'white' ? 'opp' : 'me' },
            result,
            moves,
          }),
        );
      }
    };
    play(RUY, ['w', 'w', 'w', 'w', 'l', 'd']); // 6 games, 75%
    play(QGD, ['w', 'l', 'l', 'l', 'l']); // 5 games, 20%
    play(['e4', 'c5'], ['w', 'w', 'w', 'w']); // 4 games, 100% (below the floor)
    play(NAJDORF, ['l', 'w', 'd', 'd', 'w', 'l', 'w'], 'black'); // 7 games, 57%
  });
  afterAll(async () => t.close());

  it('orders by games, then by score above the floor', () => {
    const most = openingsStats(scope, { side: 'both', order: 'most' });
    expect(most.white.map(r => [r.eco, r.games])).toEqual([
      ['C70', 6],
      ['D30', 5],
      ['B20', 4],
    ]);
    expect(OPENINGS_RANK_MIN_GAMES).toBe(5);
    const best = openingsStats(scope, { side: 'white', order: 'best' });
    expect(best.white.map(r => r.eco)).toEqual(['C70', 'D30']);
    expect(best.black).toEqual([]);
    const worst = openingsStats(scope, { side: 'white', order: 'worst' });
    expect(worst.white.map(r => r.eco)).toEqual(['D30', 'C70']);
    const strict = openingsStats(scope, { side: 'both', order: 'best', minGames: 6 });
    expect(strict.white.map(r => r.eco)).toEqual(['C70']);
    expect(strict.black.map(r => [r.eco, r.w, r.d, r.l])).toEqual([['B90', 3, 2, 2]]);
  });

  it('honours the row limit and the filters', () => {
    expect(openingsStats(scope, { side: 'white', order: 'most', limit: 1 }).white).toHaveLength(1);
    const wins = openingsStats({ ...scope, filters: { outcome: ['w'] } }, { side: 'white', order: 'most' });
    expect(wins.white.map(r => [r.eco, r.games, r.l])).toEqual([
      ['B20', 4, 0], // ties by ECO
      ['C70', 4, 0],
      ['D30', 1, 0],
    ]);
    const line = openingsStats({ ...scope, filters: { line: ['e2e4', 'c7c5'] } }, { side: 'both', order: 'most', maxMoves: 1 });
    expect(line.white.map(r => r.name)).toEqual(['Sicilian Defense']);
    expect(line.black.map(r => [r.eco, r.games])).toEqual([['B20', 7]]);
  });

  it('gives a row the line its games reached, also through a transposition', async () => {
    const t2 = await makeTestApp();
    try {
      const me = createSource(t2.db, { kind: 'lichess', key: 'me' });
      const s2: StatsScope = { db: t2.db, sourceIds: [me], filters: {} };
      // 1.d4 d5 2.Bf4 c5 3.e3 cxd4 4.exd4 transposes into the Caro-Kann Exchange's "4.Bf4" position;
      // it never passes through the name's shortest line (1.e4 c6 2.d4 d5 3.exd5).
      for (const moves of [
        ['d4', 'd5', 'Bf4', 'c5', 'e3', 'cxd4', 'exd4', 'a6'],
        ['d4', 'd5', 'Bf4', 'c5', 'e3', 'cxd4', 'exd4', 'h6'],
        ['d4', 'd5', 'Nf3', 'c5', 'e3', 'cxd4', 'exd4', 'Nc6', 'a3'],
      ]) {
        insertGame(t2.db, testGame({ white: { name: 'me' }, black: { name: 'opp' }, moves }));
      }
      const row = openingsStats(s2, { side: 'white', order: 'most' }).white.find(r => r.name === 'Caro-Kann Defense: Exchange Variation')!;
      expect(row).toMatchObject({ eco: 'B13', games: 3, line: 'e2e4,c7c6,d2d4,d7d5,e4d5,c6d5,c1f4' });
      // The line filter (by position) finds the games that reached it.
      const filtered = openingsStats({ ...s2, filters: { line: row.line.split(',') } }, { side: 'white', order: 'most' });
      expect(filtered.white.find(r => r.eco === 'B13')?.games).toBe(2);
    } finally {
      await t2.close();
    }
  });
});

describe('opponents', () => {
  let t: TestApp;
  let scope: StatsScope;

  beforeAll(async () => {
    t = await makeTestApp();
    const me = createSource(t.db, { kind: 'lichess', key: 'me' });
    scope = { db: t.db, sourceIds: [me], filters: {} };
    const game = (opp: string, days: number, over: { title?: 'GM' | 'BOT' | null; rating?: number; name?: string } = {}) =>
      insertGame(
        t.db,
        testGame({ endedAt: T0 + days * DAY, white: { name: 'me' }, black: { name: over.name ?? opp, title: over.title ?? null, rating: over.rating ?? 1500 } }),
      );
    game('gm', 1, { title: 'GM', rating: 2600 });
    game('gm', 2, { title: 'GM', rating: 2650, name: 'GM' }); // renamed case: latest name wins
    game('bot', 3, { title: 'BOT' });
    game('cached', 4);
    t.db.run("INSERT INTO players_cache (kind, key, country, title, fetched_at) VALUES ('lichess', 'cached', 'gb-sct', 'IM', 1)");
    t.db.run("INSERT INTO players_cache (kind, key, country, title, fetched_at) VALUES ('lichess', 'gm', '_earth', NULL, 1)");
  });
  afterAll(async () => t.close());

  it('takes name, title and rating from the latest game and fills gaps from the cache', () => {
    const page = opponentsPage(scope, { view: 'most', page: 1, pageSize: 20, viewer: null });
    expect(page.rows.map(r => [r.key, r.name, r.title, r.lastRating, r.country, r.games])).toEqual([
      ['gm', 'GM', 'GM', 2650, null, 2],
      ['cached', 'cached', 'IM', 1500, 'GB', 1],
      ['bot', 'bot', 'BOT', 1500, null, 1],
    ]);
  });

  it('lists titled opponents without bots', () => {
    const titled = opponentsPage(scope, { view: 'titled', page: 1, pageSize: 20, viewer: null });
    expect(titled.total).toBe(2);
    expect(titled.rows.map(r => r.key)).toEqual(['gm', 'cached']);
    expect(opponentsPage(scope, { view: 'titled', page: 3, pageSize: 1, viewer: null })).toMatchObject({ total: 2, rows: [] });
  });
});

describe('country codes', () => {
  it('normalises to ISO 3166-1 alpha-2', () => {
    expect(normalizeCountry('no')).toBe('NO');
    expect(normalizeCountry('XK')).toBe('XK');
    expect(normalizeCountry('GB-ENG')).toBe('GB');
    expect(normalizeCountry('XE')).toBe('GB');
    expect(normalizeCountry(' xs ')).toBe('GB');
    expect(normalizeCountry('XC')).toBe('ES'); // Catalonia (Chess.com)
    expect(normalizeCountry('XP')).toBe('PS');
    expect(normalizeCountry('ES-CT')).toBe('ES');
    for (const bad of [null, '', '_earth', '_pirate', 'EU', 'UN', 'XX', 'XY', 'ZZ', 'AA', 'QZ', 'USA', '12', 'G1']) {
      expect(normalizeCountry(bad), String(bad)).toBeNull();
    }
  });
});

describe('rating history', () => {
  let t: TestApp;
  let scope: StatsScope;

  beforeAll(async () => {
    t = await makeTestApp();
    const me = createSource(t.db, { kind: 'lichess', key: 'me' });
    scope = { db: t.db, sourceIds: [me], filters: {} };
    t.db.tx(() => {
      // 1,200 rated blitz games over 600 days (two a day, 30 minutes apart), rating 1000 + i;
      // opponents 100 points stronger; wins on even i. Plus 30 unrated rapid games.
      for (let i = 0; i < 1200; i++) {
        const at = T0 + Math.floor(i / 2) * DAY + (i % 2) * 1_800_000;
        insertGame(
          t.db,
          testGame({
            startedAt: at - 60_000,
            endedAt: at,
            white: { name: 'me', rating: 1000 + i, ratingAfter: 1001 + i },
            black: { name: 'opp', rating: 1100 + i },
            result: i % 2 === 0 ? '1-0' : '0-1',
            timeClass: 'blitz' as TimeClass,
          }),
        );
      }
      for (let i = 0; i < 30; i++) {
        insertGame(t.db, testGame({ endedAt: T0 + i * DAY + 3_600_000, white: { name: 'me', rating: 1500 }, black: { name: 'opp' }, timeClass: 'rapid', rated: false }));
      }
    });
  });
  afterAll(async () => t.close());

  it('keeps one point per day from rated games, downsampled with the ends kept', () => {
    const [series, ...rest] = ratingSeries(scope);
    expect(rest).toEqual([]);
    expect(series!.timeClass).toBe('blitz');
    expect(series!.points).toHaveLength(500);
    expect(series!.points[0]).toEqual([T0 + 1_800_000, 1002]); // the day's last game
    expect(series!.points.at(-1)).toEqual([T0 + 599 * DAY + 1_800_000, 2200]);
    const ts = series!.points.map(p => p[0]);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
    const full = ratingSeries(scope, { maxPoints: 10_000 });
    expect(full[0]!.points).toHaveLength(600);
    const recent = ratingSeries(scope, { since: T0 + 590 * DAY });
    expect(recent[0]!.points).toHaveLength(10);
  });

  it('averages the last n games', () => {
    const avg = ratingAverages(scope);
    expect(avg.map(a => a.n)).toEqual([10, 20, 50, 100, 200, 500, 1000, null]);
    // The 10 newest games are blitz i = 1190…1199 (the unrated rapid games are older).
    expect(avg[0]).toEqual({ n: 10, games: 10, avgRating: Math.round(1000 + 1194.5), avgOppRating: Math.round(1100 + 1194.5), score: 0.5 });
    expect(avg.at(-1)).toMatchObject({ n: null, games: 1230 });
    const blitzOnly = ratingAverages({ ...scope, filters: { tc: ['blitz'], outcome: ['w'] } });
    expect(blitzOnly.at(-1)).toMatchObject({ n: null, games: 600, score: 1 });
  });

  it('downsamples with largest-triangle-three-buckets', () => {
    const pts: Array<[number, number]> = Array.from({ length: 1000 }, (_, i) => [i, i === 500 ? 9999 : 0]);
    const out = lttb(pts, 20);
    expect(out).toHaveLength(20);
    expect(out[0]).toEqual([0, 0]);
    expect(out.at(-1)).toEqual([999, 0]);
    expect(out).toContainEqual([500, 9999]); // the spike survives
    expect(lttb(pts.slice(0, 5), 20)).toHaveLength(5);
  });
});
