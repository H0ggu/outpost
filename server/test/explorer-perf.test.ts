/**
 * Performance of the player explorer on a large profile (PLAN: ~50k games; < 300 ms at the start
 * position and a few plies deep). 400 synthetic template games (a skewed random walk, so lines
 * share prefixes like real repertoires) are stored with insertGame; 50,000 profile games and 25,000
 * reference-DB games are then cloned from them in SQL (games, player_games and positions rows
 * shaped exactly like insertGame's).
 */
import type { ExplorerGamesPage, ExplorerPlayerResponse, Id } from '@outpost/shared/api';
import { stdUci } from '@outpost/shared/chess';
import { encodeFiltersSegment } from '@outpost/shared/filters';
import { Chess } from 'chessops/chess';
import { makeSan } from 'chessops/san';
import type { Move } from 'chessops/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertGame } from '../src/chess/store.ts';
import { resolveGameSet } from '../src/explorer/gameSet.ts';
import { hitsQuery, setConditions } from '../src/explorer/query.ts';
import { createDatabase, createProfile, lastNdjsonLine } from './explorer-support.ts';
import { createSource, createUserSession, makeTestApp, testGame, type TestApp } from './helpers.ts';

const PROFILE_GAMES = 50_000;
const OTHER_GAMES = 25_000;
const TEMPLATES = 400;
const BUDGET_MS = 300;

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

describe('player explorer performance (50k-game profile)', () => {
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
    const copyPositions = db.prepare('INSERT INTO positions (game_id, ply, pos_key, next_uci) SELECT ?, ply, pos_key, next_uci FROM positions WHERE game_id = ?');
    const insertPlayerGame = db.prepare(
      `INSERT INTO player_games (source_id, game_id, color, outcome, rating, rating_after, opp_name, opp_key, opp_rating,
         opp_title, opp_source_kind, ended_at, time_class, rated)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, 'lichess', ?, ?, ?)`,
    );
    const results = ['1-0', '0-1', '1/2-1/2'] as const;
    const classes = ['bullet', 'blitz', 'blitz', 'rapid', 'classical'] as const;
    const t0 = Date.UTC(2020, 0, 1);
    db.tx(() => {
      for (let i = 0; i < PROFILE_GAMES + OTHER_GAMES; i++) {
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
        copyPositions.run(gameId, tpl.id);
        if (mine) {
          const outcome = result === '1/2-1/2' ? 'd' : (result === '1-0') === white ? 'w' : 'l';
          insertPlayerGame.run(sourceId, gameId, white ? 'w' : 'b', outcome, myRating, opp, opp, oppRating, endedAt, tc, rated);
        }
      }
    });
    expect(db.value<number>('SELECT count(*) FROM player_games WHERE source_id = ?', [sourceId])).toBe(PROFILE_GAMES);
  }, 300_000);

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
    // The reference explorer over 25k games: first (uncached) answer, then from the result cache.
    const refStart = performance.now();
    const ref = await t.app.inject({ url: '/api/explorer/reference', headers: { cookie } });
    const refMs = performance.now() - refStart;
    expect(ref.statusCode).toBe(200);
    expect(ref.json().white + ref.json().draws + ref.json().black).toBe(OTHER_GAMES);
    report.push(`reference start (25k games, uncached): ${refMs.toFixed(1)} ms`);
    expect(refMs).toBeLessThan(BUDGET_MS);
    const refCached = await timed('/api/explorer/reference');
    report.push(`reference start (cached): ${refCached.ms.toFixed(1)} ms`);
    const games = await timed('/api/explorer/games?player=perf');
    const page = JSON.parse(games.body) as ExplorerGamesPage;
    report.push(`games list (start): ${page.total.toLocaleString('en')} games, ${games.ms.toFixed(1)} ms`);
    expect(page.total).toBe(PROFILE_GAMES);
    expect(games.ms).toBeLessThan(BUDGET_MS * 2);
    console.info(`player explorer timings:\n  ${report.join('\n  ')}`);
  }, 120_000);

  it('drives the set plan from player_games and seeks positions by (pos_key, game_id)', () => {
    const set = resolveGameSet(t.db, { kind: 'profile', slug: 'perf' }, { id: 0, username: 'x', role: 'admin', totpEnabled: false, prefs: {} as never });
    const where = setConditions(set, {}, { timeClasses: null, rated: null, from: null, to: null }, { color: 'white' });
    const start = t.db.value<number>('SELECT pos_key FROM positions WHERE ply = 0 LIMIT 1')!;
    const q = hitsQuery(t.db, set, where, start, 'white');
    expect(q.plan).toBe('set');
    const plan = t.db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${q.sql}`, q.params).map(r => r.detail);
    expect(plan[0]).toMatch(/^SEARCH pg USING (PRIMARY KEY|INDEX)/);
    expect(plan[1]).toMatch(/^SEARCH p USING COVERING INDEX positions_key \(pos_key=\? AND game_id=\?\)/);
  });
});
