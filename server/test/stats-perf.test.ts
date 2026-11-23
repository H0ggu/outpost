/**
 * Performance of every stats endpoint on one profile with 100k games (PLAN §6; budget ~300 ms).
 *
 * Seeding takes ~10 s (stats-seed.ts). Each endpoint is called once to warm SQLite's page cache,
 * then timed twice; the better time must stay under the budget, which keeps the check
 * meaningful while other test files compete for the CPU. The same checks run again after ANALYZE,
 * because `PRAGMA optimize` (run when the database closes) creates sqlite_stat1 and that changes
 * SQLite's plans; and no stats query may fall back to a full table scan.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API_ROUTES } from '@outpost/shared/api';
import { parseFilters } from '@outpost/shared/filters';
import type { Db } from '../src/db/index.ts';
import {
  activityStats,
  behaviourStats,
  gamesPage,
  openingsStats,
  opponentsPage,
  overviewStats,
  prepareProfilePgnExport,
  ratingStats,
  worldMapStats,
  type StatsScope,
} from '../src/stats/index.ts';
import { createUserSession, makeTestApp, type TestApp } from './helpers.ts';
import { seedLargeProfile, type SeededProfile } from './stats-seed.ts';

const GAMES = 100_000;
const BUDGET_MS = Number(process.env.OUTPOST_PERF_BUDGET_MS ?? 300);

const ENDPOINTS: Array<[keyof typeof API_ROUTES.stats, string]> = [
  ['overview', ''],
  ['overview', 'tc=blitz&color=white'],
  ['overview', 'line=e2e4'],
  ['overview', 'oppName=opp1&period=12m'],
  ['games', ''],
  ['games', 'page=4000'],
  ['games', 'line=e2e4,e7e5&outcome=w,d'],
  ['games', 'event=arena&rated=rated'],
  ['gamesPgn', ''],
  ['openings', ''],
  ['openings', 'maxMoves=3'],
  ['openings', 'maxMoves=5&minMoves=2&order=best&side=black'],
  ['opponents', ''],
  ['opponents', 'view=titled'],
  ['opponents', 'page=150&opp=-100'],
  ['behaviour', ''],
  ['worldmap', ''],
  ['activity', 'tz=Europe/Oslo'],
  ['activity', 'tz=Asia/Kathmandu&color=black'],
  ['rating', ''],
  ['rating', 'src=1&tc=rapid'],
];

describe(`stats performance on a ${GAMES / 1000}k-game profile`, () => {
  let t: TestApp;
  let cookie: string;
  let seeded: SeededProfile;

  beforeAll(async () => {
    t = await makeTestApp();
    const user = createUserSession(t.db, { username: 'perf' });
    cookie = user.cookie;
    seeded = seedLargeProfile(t.db, { slug: 'perf', ownerUserId: user.userId, total: GAMES });
  }, 300_000);
  afterAll(async () => t?.close());

  const time = async (kind: keyof typeof API_ROUTES.stats, query: string): Promise<{ best: number; status: number; bytes: number }> => {
    const url = `${API_ROUTES.stats[kind](seeded.slug)}${query ? `?${query}` : ''}`;
    let res = await t.app.inject({ method: 'GET', url, headers: { cookie } });
    const times: number[] = [];
    for (let i = 0; i < 2; i++) {
      const t0 = performance.now();
      res = await t.app.inject({ method: 'GET', url, headers: { cookie } });
      times.push(performance.now() - t0);
    }
    return { best: Math.min(...times), status: res.statusCode, bytes: res.rawPayload.length };
  };

  const checkAll = async (): Promise<void> => {
    const slow: string[] = [];
    for (const [kind, query] of ENDPOINTS) {
      const r = await time(kind, query);
      expect(r.status, `${kind}?${query}`).toBe(200);
      if (r.best > BUDGET_MS) slow.push(`${kind}?${query}: ${r.best.toFixed(0)} ms`);
    }
    expect(slow).toEqual([]);
  };

  it('seeds the profile', () => {
    expect(t.db.value<number>('SELECT COUNT(*) FROM player_games WHERE source_id IN (?, ?)', seeded.sourceIds)).toBe(GAMES);
  });

  it(`answers every endpoint within ${BUDGET_MS} ms`, checkAll, 120_000);

  it('never scans a whole table', () => {
    const scope: StatsScope = { db: t.db, sourceIds: seeded.sourceIds, filters: {} };
    const plans = capturePlans(t.db, () => {
      for (const q of ['', 'line=e2e4&event=arena', 'tc=blitz&period=12m&opp=eq&oppName=opp']) {
        const s = { ...scope, filters: parseFilters(new URLSearchParams(q)) };
        overviewStats(s);
        gamesPage(s, 3, 20);
        openingsStats(s, { side: 'both', order: 'most', maxMoves: 3 });
        opponentsPage(s, { view: 'titled', page: 1, pageSize: 20, viewer: null });
        behaviourStats(s);
        worldMapStats(s);
        activityStats(s, 'Europe/Oslo');
        ratingStats(s);
        [...prepareProfilePgnExport(s, 'x', 10).chunks()];
      }
    });
    expect(plans.length).toBeGreaterThan(30);
    const scans = plans.flatMap(p => p.plan.filter(d => /^SCAN (pg|g|p|pc|f_ln|f_ev|player_games|games|positions|players_cache)\b/.test(d)).map(d => `${d}  <=  ${p.sql.slice(0, 120)}`));
    expect(scans).toEqual([]);
  }, 60_000);

  it('keeps its plans after ANALYZE', async () => {
    t.db.exec('ANALYZE');
    expect(t.db.value<number>("SELECT COUNT(*) FROM sqlite_stat1 WHERE tbl = 'player_games'")).toBeGreaterThan(0);
    await checkAll();
  }, 120_000);

  it('names indexes that exist', () => {
    // INDEXED BY in src/stats: the WITHOUT ROWID primary key of player_games, positions_key (001)
    // and games_stats (300).
    const pk = t.db.all<{ name: string }>("SELECT name FROM pragma_index_list('player_games') WHERE origin = 'pk'");
    expect(pk.map(r => r.name)).toEqual(['sqlite_autoindex_player_games_1']);
    const names = t.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index'").map(r => r.name);
    expect(names).toEqual(expect.arrayContaining(['positions_key', 'games_stats']));
  });
});

/** Runs `fn`, recording the EXPLAIN QUERY PLAN of every query it makes through `db`. */
function capturePlans(db: Db, fn: () => void): Array<{ sql: string; plan: string[] }> {
  const out: Array<{ sql: string; plan: string[] }> = [];
  const methods = ['all', 'get', 'value'] as const;
  const originals = methods.map(m => db[m]);
  for (const m of methods) {
    const orig = db[m].bind(db) as (sql: string, params?: unknown) => unknown;
    (db as unknown as Record<string, unknown>)[m] = (sql: string, params: unknown[] = []) => {
      const plan = db.raw
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...(params as Array<string | number | null>))
        .map(r => String((r as { detail: string }).detail));
      out.push({ sql: sql.replace(/\s+/g, ' '), plan });
      return orig(sql, params);
    };
  }
  try {
    fn();
  } finally {
    methods.forEach((m, i) => ((db as unknown as Record<string, unknown>)[m] = originals[i]));
  }
  return out;
}
