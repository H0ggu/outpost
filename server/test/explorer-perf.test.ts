/**
 * Performance of the local explorers on large data:
 * - the player explorer on a ~50k-game profile (PLAN: < 300 ms at the start position and a few
 *   plies deep);
 * - the reference-backed explorers (reference, masters from a reference DB, player/games for
 *   db:<ref>) on a large reference database: time, event-loop responsiveness while a cold query
 *   runs, and the result cache surviving unrelated writes.
 *
 * 400 synthetic template games (a skewed random walk, so lines share prefixes like real
 * repertoires) are stored with insertGame; the profile and reference games are then cloned from them
 * in SQL (games, player_games and positions rows shaped exactly like insertGame's; the triggers of
 * migration 401 keep explorer_db_stats).
 *
 * The reference DB has `OUTPOST_PERF_REFERENCE_GAMES` games (default 150,000, about 10 s to seed);
 * `OUTPOST_PERF_REFERENCE_GAMES=1000000 npx vitest run server/test/explorer-perf.test.ts` runs the
 * million-game check (several minutes to seed; budgets scale with the size at the shallow plies).
 */
import type { ExplorerGamesPage, ExplorerMastersResponse, ExplorerPlayerResponse, Id } from '@outpost/shared/api';
import { stdUci } from '@outpost/shared/chess';
import { encodeFiltersSegment } from '@outpost/shared/filters';
import { Chess } from 'chessops/chess';
import { makeSan } from 'chessops/san';
import type { Move } from 'chessops/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getOpeningBook } from '../src/chess/openings.ts';
import { insertGame } from '../src/chess/store.ts';
import { referenceGameSet, resolveGameSet } from '../src/explorer/gameSet.ts';
import { resolvePosition } from '../src/explorer/position.ts';
import { choosePlan, hitsSql, setConditions } from '../src/explorer/query.ts';
import { writeSettings } from '../src/settings.ts';
import { createDatabase, createProfile, lastNdjsonLine } from './explorer-support.ts';
import { createSource, createUserSession, makeTestApp, testGame, type TestApp } from './helpers.ts';

const PROFILE_GAMES = 50_000;
const OTHER_GAMES = Number(process.env.OUTPOST_PERF_REFERENCE_GAMES ?? 150_000);
const TEMPLATES = 400;
const BUDGET_MS = 300;
/**
 * Uncached reference answers at the first two plies, where most of the DB is read: ~1 µs per game
 * measured (150 ms for 150k games, 0.9 s for a million), budgeted at 3 µs (other test files share
 * the CPU). Deeper plies get the profile's 300 ms.
 */
const REFERENCE_SHALLOW_BUDGET_MS = Math.max(500, OTHER_GAMES * 0.003);
/** Longest a cold reference query may hold the event loop (slices target 25 ms). */
const MAX_EVENT_LOOP_LAG_MS = 150;

/** Deterministic PRNG (mulberry32). */
const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const hash = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

/** A random game whose move choice is skewed (geometric) over a per-position preference order. */
function templateMoves(rand: () => number, plies: number): string[] {
  const pos = Chess.default();
  const sans: string[] = [];
  for (let i = 0; i < plies; i++) {
    const moves: Move[] = [];
    for (const [from, dests] of pos.allDests()) {
      for (const to of dests) {
        const piece = pos.board.get(from);
        const promotes = piece?.role === 'pawn' && (to >> 3 === 7 || to >> 3 === 0);
        moves.push(promotes ? { from, to, promotion: 'queen' } : { from, to });
      }
    }
    if (moves.length === 0) break;
    const ranked = moves
      .map(m => ({ m, k: hash(`${pos.board.occupied.lo}:${pos.board.occupied.hi}:${pos.turn}:${stdUci(pos, m)}`) }))
      .sort((a, b) => a.k - b.k);
    let idx = 0;
    while (idx < ranked.length - 1 && rand() < 0.45) idx++;
    const move = ranked[idx]!.m;
    sans.push(makeSan(pos, move));
    pos.play(move);
  }
  return sans;
}

describe(`local explorer performance (50k-game profile, ${OTHER_GAMES.toLocaleString('en')}-game reference DB)`, () => {
  let t: TestApp;
  let cookie: string;
  let sourceId: Id;
  let refDb: Id;

  beforeAll(async () => {
    t = await makeTestApp();
    const db = t.db;
    cookie = createUserSession(db, { username: 'perf' }).cookie;
    sourceId = createSource(db, { kind: 'lichess', key: 'perfuser' });
    createProfile(db, { slug: 'perf', ownerId: null, sources: [{ id: sourceId }] });
    refDb = createDatabase(db, { name: 'Reference', kind: 'reference' });

    const rand = rng(42);
    const templates: Array<{ id: Id; plies: number; sans: string }> = [];
    db.tx(() => {
      for (let i = 0; i < TEMPLATES; i++) {
        const moves = templateMoves(rand, 40 + Math.floor(rand() * 40));
        const { gameId } = insertGame(db, testGame({ originId: `tpl${i}`, moves, white: { name: 'tplw' }, black: { name: 'tplb' } }));
        const row = db.get<{ ply_count: number; moves_san: string }>('SELECT ply_count, moves_san FROM games WHERE id = ?', [gameId])!;
        templates.push({ id: gameId, plies: row.ply_count, sans: row.moves_san });
      }
    });

    const insertGameRow = db.prepare(
      `INSERT INTO games (origin, origin_id, database_id, white, black, white_key, black_key, white_rating, black_rating, result,
         termination, time_class, time_control, rated, started_at, ended_at, ply_count, moves_san)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'resign', ?, '180+2', ?, ?, ?, ?, ?)`,
    );
    const copyPositions = db.prepare(
      'INSERT INTO positions (game_id, ply, pos_key, next_uci) SELECT ?, ply, pos_key, next_uci FROM positions WHERE game_id = ? AND ply <= ?',
    );
    const insertPlayerGame = db.prepare(
      `INSERT INTO player_games (source_id, game_id, color, outcome, rating, rating_after, opp_name, opp_key, opp_rating,
         opp_title, opp_source_kind, ended_at, time_class, rated)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, 'lichess', ?, ?, ?)`,
    );
    const results = ['1-0', '0-1', '1/2-1/2'] as const;
    const classes = ['bullet', 'blitz', 'blitz', 'rapid', 'classical'] as const;
    const t0 = Date.UTC(2020, 0, 1);
    for (let batch = 0; batch < PROFILE_GAMES + OTHER_GAMES; batch += 50_000) db.tx(() => {
      for (let i = batch; i < Math.min(PROFILE_GAMES + OTHER_GAMES, batch + 50_000); i++) {
        const mine = i < PROFILE_GAMES;
        // Popular templates more often: index skewed towards 0.
        const tpl = templates[Math.floor(TEMPLATES * rand() ** 2)]!;
        const white = !mine || rand() < 0.6;
        const me = mine ? 'perfuser' : `someone${i % 3000}`;
        const opp = `opp${Math.floor(rand() * 5000)}`;
        const result = results[Math.floor(rand() * 3)]!;
        const tc = classes[Math.floor(rand() * classes.length)]!;
        const rated = rand() < 0.9 ? 1 : 0;
        const myRating = 1800 + Math.floor(rand() * 400);
        const oppRating = 1600 + Math.floor(rand() * 800);
        const endedAt = t0 + i * 3_600_000;
        const [w, b] = white ? [me, opp] : [opp, me];
        const [wr, br] = white ? [myRating, oppRating] : [oppRating, myRating];
        const gameId = Number(
          insertGameRow.run(
            mine ? 'lichess' : 'reference',
            mine ? `perf${i}` : `${refDb}:perf${i}`,
            mine ? null : refDb,
            w,
            b,
            w,
            b,
            wr,
            br,
            result,
            mine ? tc : 'classical',
            rated,
            endedAt - 600_000,
            endedAt,
            tpl.plies,
            tpl.sans,
          ).lastInsertRowid,
        );
        // Reference games keep their first 24 plies of positions (faster to seed; the explorer
        // checks stay within them), profile games all 50.
        copyPositions.run(gameId, tpl.id, mine ? 50 : 24);
        if (mine) {
          const outcome = result === '1/2-1/2' ? 'd' : (result === '1-0') === white ? 'w' : 'l';
          insertPlayerGame.run(sourceId, gameId, white ? 'w' : 'b', outcome, myRating, opp, opp, oppRating, endedAt, tc, rated);
        }
      }
    });
    expect(db.value<number>('SELECT count(*) FROM player_games WHERE source_id = ?', [sourceId])).toBe(PROFILE_GAMES);
    expect(db.value<number>('SELECT games FROM explorer_db_stats WHERE database_id = ?', [refDb])).toBe(OTHER_GAMES);
  }, 3_600_000);

  afterAll(async () => {
    await t?.close();
  });

  /** Median of three timed requests (after a warm-up), and the last answer. */
  const timed = async (url: string): Promise<{ ms: number; body: string }> => {
    await t.app.inject({ url, headers: { cookie } });
    const times: number[] = [];
    let body = '';
    for (let i = 0; i < 3; i++) {
      const start = performance.now();
      const res = await t.app.inject({ url, headers: { cookie } });
      times.push(performance.now() - start);
      expect(res.statusCode, res.body).toBe(200);
      body = res.body;
    }
    times.sort((a, b) => a - b);
    return { ms: times[1]!, body };
  };

  it('answers at the start position and along the main line in < 300 ms', async () => {
    const report: string[] = [];
    for (const color of ['white', 'black'] as const) {
      let line: string[] = [];
      for (let depth = 0; depth <= 6; depth++) {
        const { ms, body } = await timed(`/api/explorer/player?player=perf&color=${color}&play=${line.join(',')}`);
        const r = lastNdjsonLine<ExplorerPlayerResponse>(body);
        report.push(`${color} ply ${depth}: ${(r.white + r.draws + r.black).toLocaleString('en')} games, ${ms.toFixed(1)} ms`);
        expect(ms, report.at(-1)).toBeLessThan(BUDGET_MS);
        if (depth === 0) expect(r.white + r.draws + r.black).toBeGreaterThan(color === 'white' ? 25_000 : 15_000);
        if (!r.moves[0]) break;
        line = [...line, r.moves[0].uci];
      }
    }
    // Filters and lila's restrictions on top.
    const seg = encodeFiltersSegment({ tc: ['blitz', 'rapid'], opp: '100' });
    const filtered = await timed(`/api/explorer/f/${seg}/player?player=perf&color=white&speeds=blitz,rapid,classical&modes=rated`);
    report.push(`filtered start: ${filtered.ms.toFixed(1)} ms`);
    expect(filtered.ms).toBeLessThan(BUDGET_MS);
    const games = await timed('/api/explorer/games?player=perf');
    const page = JSON.parse(games.body) as ExplorerGamesPage;
    report.push(`games list (start): ${page.total.toLocaleString('en')} games, ${games.ms.toFixed(1)} ms`);
    expect(page.total).toBe(PROFILE_GAMES);
    expect(games.ms).toBeLessThan(BUDGET_MS * 2);
    console.info(`player explorer timings:\n  ${report.join('\n  ')}`);
  }, 120_000);

  it('drives the set plan from player_games and seeks positions by (pos_key, game_id)', async () => {
    const set = resolveGameSet(t.db, { kind: 'profile', slug: 'perf' }, { id: 0, username: 'x', role: 'admin', totpEnabled: false, prefs: {} as never });
    const where = setConditions(set, {}, { timeClasses: null, rated: null, from: null, to: null }, { color: 'white' });
    const start = resolvePosition(undefined, '', getOpeningBook()).key;
    const q = { set, where, key: start, color: 'white' as const };
    expect((await choosePlan(t.db, q)).plan).toBe('set');
    const h = hitsSql(q, 'set', 1, 1_000_000);
    const plan = t.db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${h.sql}`, h.params).map(r => r.detail);
    expect(plan[0]).toMatch(/^SEARCH pg USING PRIMARY KEY \(source_id=\? AND game_id>\? AND game_id<\?\)/);
    expect(plan[1]).toMatch(/^SEARCH p USING COVERING INDEX positions_key \(pos_key=\? AND game_id=\?\)/);
  });

  describe('reference database', () => {
    /** One uncached request, with the longest event-loop stall seen while it ran. */
    const cold = async (url: string): Promise<{ ms: number; lag: number; body: string }> => {
      let lag = 0;
      let last = performance.now();
      const timer = setInterval(() => {
        const now = performance.now();
        lag = Math.max(lag, now - last);
        last = now;
      }, 1);
      try {
        const start = performance.now();
        const res = await t.app.inject({ url, headers: { cookie } });
        const ms = performance.now() - start;
        expect(res.statusCode, res.body).toBe(200);
        return { ms, lag: Math.max(lag, performance.now() - last), body: res.body };
      } finally {
        clearInterval(timer);
      }
    };
    const total = (r: { white: number; draws: number; black: number }) => r.white + r.draws + r.black;
    const report: string[] = [];
    afterAll(() => console.info(`reference explorer timings (${OTHER_GAMES.toLocaleString('en')} games):\n  ${report.join('\n  ')}`));

    /**
     * The first request at a position reads its pages from disk (how long that takes depends on the
     * machine's page cache); the same scan again (a no-op restriction bypasses the result cache) is
     * the explorer's own cost, which the budgets check.
     */
    const coldAndWarm = async (url: string) => {
      const first = await cold(url);
      const again = await cold(`${url}${url.includes('?') ? '&' : '?'}since=1952-01`);
      expect(again.body).toBe(first.body);
      return { first, again, text: `${first.ms.toFixed(0)} ms first (stall ≤ ${first.lag.toFixed(0)} ms), ${again.ms.toFixed(0)} ms again (stall ≤ ${again.lag.toFixed(0)} ms)` };
    };

    it('answers the reference explorer along the main line without holding the event loop', async () => {
      let line: string[] = [];
      for (let depth = 0; depth <= 6; depth++) {
        const { first, again, text } = await coldAndWarm(`/api/explorer/reference?play=${line.join(',')}`);
        const r = JSON.parse(first.body) as ExplorerMastersResponse;
        report.push(`reference ply ${depth}: ${total(r).toLocaleString('en')} games, ${text}`);
        if (depth === 0) expect(total(r)).toBe(OTHER_GAMES);
        expect(r.topGames.length).toBeGreaterThan(0);
        expect(again.ms, report.at(-1)).toBeLessThan(depth < 2 ? REFERENCE_SHALLOW_BUDGET_MS : BUDGET_MS);
        expect(again.lag, report.at(-1)).toBeLessThan(MAX_EVENT_LOOP_LAG_MS);
        if (!r.moves[0]) break;
        line = [...line, r.moves[0].uci];
      }
    }, 600_000);

    it('serves masters from the reference DB, and db:<ref> in the player explorer and games list', async () => {
      writeSettings(t.db, { mastersSource: `reference:${refDb}` });
      try {
        const masters = await coldAndWarm('/api/explorer/masters?variant=standard&play=');
        expect(total(JSON.parse(masters.first.body) as ExplorerMastersResponse)).toBe(OTHER_GAMES);
        report.push(`masters (reference DB) start: ${masters.text}`);
        expect(masters.again.ms).toBeLessThan(REFERENCE_SHALLOW_BUDGET_MS);
        expect(masters.again.lag).toBeLessThan(MAX_EVENT_LOOP_LAG_MS);
      } finally {
        writeSettings(t.db, { mastersSource: 'lichess' });
      }
      const player = await coldAndWarm(`/api/explorer/player?player=db:${refDb}&color=white`);
      report.push(`player db:<ref> start: ${player.text}`);
      expect(total(lastNdjsonLine<ExplorerPlayerResponse>(player.first.body))).toBe(OTHER_GAMES);
      expect(player.again.ms).toBeLessThan(REFERENCE_SHALLOW_BUDGET_MS);
      expect(player.again.lag).toBeLessThan(MAX_EVENT_LOOP_LAG_MS);
      const games = await coldAndWarm(`/api/explorer/games?player=db:${refDb}`);
      const page = JSON.parse(games.first.body) as ExplorerGamesPage;
      report.push(`games db:<ref> start, page 1: ${games.text}`);
      expect(page.total).toBe(OTHER_GAMES);
      expect(page.games).toHaveLength(20);
      expect(games.again.ms).toBeLessThan(REFERENCE_SHALLOW_BUDGET_MS);
      expect(games.again.lag).toBeLessThan(MAX_EVENT_LOOP_LAG_MS);
      // The next page comes from the same scan.
      const next = await cold(`/api/explorer/games?player=db:${refDb}&page=2`);
      report.push(`games db:<ref> start, page 2: ${next.ms.toFixed(0)} ms`);
      expect(next.ms).toBeLessThan(50);
    }, 600_000);

    it('keeps cached reference answers when a profile syncs, and refreshes them when the DB changes', async () => {
      const url = '/api/explorer/reference?play=d2d4';
      const first = await cold(url);
      const again = await cold(url);
      expect(again.ms).toBeLessThan(50);
      // A profile game (another set) changes nothing.
      insertGame(t.db, testGame({ originId: 'perf-sync', white: { name: 'perfuser' }, moves: ['d4', 'd5'] }));
      const afterSync = await cold(url);
      report.push(`reference after 1. d4: uncached ${first.ms.toFixed(0)} ms, cached ${again.ms.toFixed(1)} ms, after a profile sync ${afterSync.ms.toFixed(1)} ms`);
      expect(afterSync.ms).toBeLessThan(50);
      expect(afterSync.body).toBe(first.body);
      // A game added to the reference DB is counted at once.
      insertGame(t.db, testGame({ origin: 'reference', originId: `${refDb}:perf-new`, databaseId: refDb, moves: ['d4', 'Nf6'], timeClass: 'classical' }));
      const fresh = JSON.parse((await cold(url)).body) as ExplorerMastersResponse;
      expect(total(fresh)).toBe(total(JSON.parse(first.body) as ExplorerMastersResponse) + 1);
    }, 600_000);

    it('reads the reference DB through its covering index', async () => {
      const set = referenceGameSet(t.db, refDb);
      const where = setConditions(set, {}, { timeClasses: null, rated: null, from: null, to: null }, { color: null });
      const start = resolvePosition(undefined, '', getOpeningBook()).key;
      for (const plan of ['set', 'position'] as const) {
        const h = hitsSql({ set, where, key: start, color: null }, plan, 1, 1_000_000);
        const steps = t.db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${h.sql}`, h.params).map(r => r.detail).join('\n');
        expect(steps).toMatch(plan === 'set' ? /SEARCH g USING COVERING INDEX games_explorer_db \(database_id=\? AND id>\? AND id<\?\)/ : /SEARCH g USING COVERING INDEX games_explorer_db \(database_id=\? AND id=\?\)/);
        expect(steps).toMatch(/COVERING INDEX positions_key/);
      }
    });
  });
});
