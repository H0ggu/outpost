/**
 * /api/explorer/games, /api/explorer/reference, the reference-backed masters explorer and the two
 * query plans of the local explorers.
 */
import type { DbGameRow, ExplorerGamesPage, ExplorerMastersResponse, GameRow, Id } from '@outpost/shared/api';
import { encodeFiltersSegment } from '@outpost/shared/filters';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getOpeningBook } from '../src/chess/openings.ts';
import { insertGame, pgnSourceKey } from '../src/chess/store.ts';
import { referenceGameSet, resolveGameSet, type GameSet } from '../src/explorer/gameSet.ts';
import { resolvePosition } from '../src/explorer/position.ts';
import { createLocalExplorer } from '../src/explorer/local.ts';
import { choosePlan, gamesPageDirect, hitsSql, positionRowsUpTo, scanPosition, setConditions, type PositionQuery, type ScanResult } from '../src/explorer/query.ts';
import { writeSettings } from '../src/settings.ts';
import { createDatabase, createProfile, expectSameShape, fixtureText, sans } from './explorer-support.ts';
import { createSource, createUserSession, makeTestApp, testGame, type TestApp } from './helpers.ts';

const day = (m: number, d = 15): number => Date.UTC(2025, m - 1, d, 12);
const NO_RESTRICTIONS = { timeClasses: null, rated: null, from: null, to: null };

describe('local explorers', () => {
  let t: TestApp;
  let owner: string;
  let other: string;
  let ownerId: Id;
  let refA: Id;
  let refB: Id;
  let gamesDb: Id;
  const ids: Record<string, Id> = {};
  let upstreamCalls: string[] = [];

  beforeAll(async () => {
    t = await makeTestApp({
      fetch: async input => {
        const url = String(input instanceof Request ? input.url : input);
        upstreamCalls.push(url);
        return Response.json(JSON.parse(fixtureText('masters-sample.json')));
      },
    });
    const db = t.db;
    owner = createUserSession(db, { username: 'olga' }).cookie;
    ownerId = db.value<Id>("SELECT id FROM users WHERE username = 'olga'")!;
    other = createUserSession(db, { username: 'oscar' }).cookie;
    refA = createDatabase(db, { name: 'Broadcasts', kind: 'reference' });
    refB = createDatabase(db, { name: 'OTB', kind: 'reference' });
    gamesDb = createDatabase(db, { name: 'private', kind: 'games', ownerId });

    const sA = createSource(db, { kind: 'lichess', key: 'alice' });
    const sB = createSource(db, { kind: 'lichess', key: 'alice2' });
    const sP = createSource(db, { kind: 'pgn', key: pgnSourceKey(gamesDb, 'Me'), databaseId: gamesDb });
    createProfile(db, { slug: 'alice', ownerId, sources: [{ id: sA }, { id: sB }] });
    createProfile(db, { slug: 'mine', ownerId, visibility: 'private', sources: [{ id: sP }] });

    const g = (key: string, over: Parameters<typeof testGame>[0]) => {
      ids[key] = insertGame(db, testGame(over)).gameId;
    };
    const at = (m: number, d?: number) => ({ startedAt: day(m, d) - 600_000, endedAt: day(m, d) });
    // Profile games.
    g('p1', { ...at(1), moves: sans('e4 e5 Nf3'), result: '1-0' });
    g('p2', { ...at(2), moves: sans('e4 c5'), result: '0-1', timeClass: 'rapid' });
    g('p3', { ...at(3), moves: sans('e4 e5 Bc4'), result: '1/2-1/2', timeClass: 'bullet' });
    g('p4', { ...at(4), moves: sans('d4 d5'), result: '1-0', white: { name: 'bob' }, black: { name: 'alice' } });
    // Alice's two accounts played each other: one game, two player_games rows.
    g('p5', { ...at(5), moves: sans('e4 e6'), result: '1-0', white: { name: 'alice2' }, black: { name: 'alice' } });
    // Private PGN database.
    g('d1', {
      ...at(6),
      origin: 'pgn',
      originId: `${gamesDb}:d1`,
      databaseId: gamesDb,
      moves: sans('e4 e5'),
      white: { name: 'Me' },
      black: { name: 'Club Player' },
      timeClass: 'unknown',
    });
    // Reference games (two databases).
    const ref = (key: string, dbId: Id, m: number, moves: string, result: '1-0' | '0-1' | '1/2-1/2', wr: number | null, br: number | null, extra = {}) =>
      g(key, {
        ...at(m),
        origin: 'reference',
        originId: `${dbId}:${key}`,
        databaseId: dbId,
        moves: sans(moves),
        result,
        timeClass: 'classical',
        event: key === 'r4' ? 'Candidates 2025' : 'Open',
        round: '1.1',
        white: { name: `W ${key}`, rating: wr, title: 'GM', fideId: key === 'r1' ? '99999902' : null },
        black: { name: `B ${key}`, rating: br, title: null },
        ...extra,
      });
    ref('r1', refA, 1, 'e4 e5 Nf3 Nc6', '1-0', 2700, 2600);
    ref('r2', refA, 2, 'e4 c5 Nf3', '0-1', 2500, 2550);
    ref('r3', refA, 3, 'd4 Nf6 c4', '1/2-1/2', 2800, 2780);
    ref('r4', refB, 4, 'e4 e5 Nf3 Nf6', '1/2-1/2', 2750, 2760, { timeClass: 'rapid' });
    ref('r5', refB, 5, 'e4 e5 Bc4', '1-0', null, null);
  });

  afterAll(async () => {
    await t?.close();
  });

  const inject = (url: string, cookie: string | null = other) => t.app.inject({ url, headers: cookie ? { cookie } : {} });

  describe('/api/explorer/games', () => {
    const page = async (q: string, cookie: string | null = other): Promise<ExplorerGamesPage> => {
      const res = await inject(`/api/explorer/games?${q}`, cookie);
      expect(res.statusCode, res.body).toBe(200);
      return res.json();
    };

    it('lists a profile’s games reaching a position, newest first, as GameRows', async () => {
      const r = await page('player=alice&play=e2e4');
      expect(r.perspective).toBe('player');
      // p1, p2, p3 (alice White), p5 (alice2 White / alice Black: listed once).
      expect(r.total).toBe(4);
      expect(r.games.map(x => x.id)).toEqual([ids.p5, ids.p3, ids.p2, ids.p1]);
      const row = r.games[1] as GameRow;
      expect(row).toMatchObject({ color: 'white', outcome: 'd', timeClass: 'bullet', opponent: { name: 'bob' } });
      expect(r).toMatchObject({ page: 1, pageSize: 20 });
    });

    it('pages', async () => {
      const r = await page('player=alice&play=e2e4&page=2&pageSize=3');
      expect(r.total).toBe(4);
      expect(r.games.map(x => x.id)).toEqual([ids.p1]);
      expect(r).toMatchObject({ page: 2, pageSize: 3 });
    });

    it('includes games that ended at the position', async () => {
      const r = await page('player=alice&play=e2e4,c7c5');
      expect(r.games.map(x => x.id)).toEqual([ids.p2]);
    });

    it('applies the filters (query) and lila’s restrictions', async () => {
      expect((await page('player=alice&play=e2e4&tc=rapid')).games.map(x => x.id)).toEqual([ids.p2]);
      expect((await page('player=alice&play=e2e4&speeds=ultraBullet')).games.map(x => x.id)).toEqual([ids.p3]);
      expect((await page('player=alice&color=black')).games.map(x => x.id)).toEqual([ids.p5, ids.p4]);
      const blackP5 = (await page('player=alice&color=black&play=e2e4')).games[0] as GameRow;
      expect(blackP5).toMatchObject({ id: ids.p5, color: 'black', outcome: 'l' });
      expect((await page('player=alice&since=2025-03&until=2025-04')).total).toBe(2);
      expect((await page('player=alice&outcome=d')).games.map(x => x.id)).toEqual([ids.p3]);
    });

    it('lists database and reference games as neutral rows', async () => {
      const own = await page(`player=db:${gamesDb}`, owner);
      expect(own.perspective).toBe('neutral');
      expect(own.games.map(x => x.id)).toEqual([ids.d1]);
      expect((own.games[0] as DbGameRow).white).toEqual({ name: 'Me', rating: 1500, title: null });
      const ref = await page('player=ref:99999902&play=e2e4');
      expect(ref).toMatchObject({ perspective: 'neutral', total: 1 });
      expect((await page('player=ref:99999902&color=black')).total).toBe(0);
      expect((await page('player=ref:99999902&color=white')).total).toBe(1);
    });

    it('checks access and validates', async () => {
      expect((await inject(`/api/explorer/games?player=db:${gamesDb}`)).statusCode).toBe(404);
      expect((await inject('/api/explorer/games?player=mine')).statusCode).toBe(404);
      expect((await inject('/api/explorer/games?player=mine', owner)).statusCode).toBe(200);
      expect((await inject('/api/explorer/games?player=alice', null)).statusCode).toBe(401);
      expect((await inject('/api/explorer/games')).statusCode).toBe(400);
      expect((await inject('/api/explorer/games?player=alice&tc=hyper')).statusCode).toBe(400);
      expect((await inject('/api/explorer/games?player=alice&pageSize=1000')).statusCode).toBe(400);
      expect((await inject('/api/explorer/games?player=alice&play=e2e5')).statusCode).toBe(400);
    });
  });

  describe('/api/explorer/reference (masters shape)', () => {
    const ref = async (q: string, path = '/api/explorer/reference'): Promise<ExplorerMastersResponse> => {
      const res = await inject(`${path}?${q}`);
      expect(res.statusCode, res.body).toBe(200);
      return res.json();
    };

    it('answers in the shape of explorer.lichess.org/masters', async () => {
      const r = await ref('play=e2e4&source=analysis');
      expectSameShape(r, JSON.parse(fixtureText('masters-sample.json')), { nullable: ['game', 'opening', 'winner', 'month'], optional: ['title'] });
      expect(r).not.toHaveProperty('recentGames');
      expect(r.topGames[0]).not.toHaveProperty('speed');
    });

    it('sums every reference database', async () => {
      const r = await ref('');
      expect(r.moves.map(m => [m.uci, m.san, m.white, m.draws, m.black])).toEqual([
        ['e2e4', 'e4', 2, 1, 1],
        ['d2d4', 'd4', 0, 1, 0],
      ]);
      expect([r.white, r.draws, r.black]).toEqual([2, 2, 1]);
      // Average of both players' known ratings; r5 has none.
      expect(r.moves[0]!.averageRating).toBe(Math.round((2700 + 2600 + 2500 + 2550 + 2750 + 2760) / 6));
      expect(r.moves[1]!.game).toMatchObject({ id: `op${ids.r3}`, winner: null, year: 2025, month: '2025-03' });
      expect(r.moves[1]!.game!.white).toEqual({ name: 'W r3', rating: 2800, title: 'GM' });
    });

    it('orders topGames by average rating and gives the move played', async () => {
      const r = await ref('');
      expect(r.topGames.map(g => [g.id, g.uci])).toEqual([
        [`op${ids.r3}`, 'd2d4'],
        [`op${ids.r4}`, 'e2e4'],
        [`op${ids.r1}`, 'e2e4'],
        [`op${ids.r2}`, 'e2e4'],
        [`op${ids.r5}`, 'e2e4'],
      ]);
      expect((await ref('topGames=2')).topGames).toHaveLength(2);
      expect((await ref('moves=1')).moves).toHaveLength(1);
    });

    it('applies lila’s year since/until and the neutral filters of the segment', async () => {
      expect((await ref('since=2025&until=2025')).white).toBe(2);
      expect((await ref('until=2024')).moves).toEqual([]);
      const seg = encodeFiltersSegment({ tc: ['rapid'], color: 'black', outcome: ['l'] });
      const rapid = await ref('', `/api/explorer/f/${seg}/reference`);
      // tc applies; the player filters (colour, outcome) have no meaning here and are ignored.
      expect(rapid.moves.map(m => [m.uci, m.draws])).toEqual([['e2e4', 1]]);
      const ev = await ref('', `/api/explorer/f/${encodeFiltersSegment({ event: 'candidates' })}/reference`);
      expect(ev.white + ev.draws + ev.black).toBe(1);
    });

    it('names the opening', async () => {
      const r = await ref('play=e2e4,e7e5,g1f3');
      expect(r.opening).toEqual({ eco: 'C40', name: "King's Knight Opening" });
      // One game each: the more recent (r4, 2…Nf6) first.
      expect(r.moves.map(m => [m.san, m.opening?.name ?? null])).toEqual([
        ['Nf6', "Petrov's Defense"],
        ['Nc6', "King's Knight Opening: Normal Variation"],
      ]);
    });

    it('needs a viewer', async () => {
      expect((await inject('/api/explorer/reference', null)).statusCode).toBe(401);
    });
  });

  describe('masters backed by a reference database', () => {
    it('answers from the configured database without calling Lichess', async () => {
      writeSettings(t.db, { mastersSource: `reference:${refA}` });
      upstreamCalls = [];
      try {
        const res = await inject('/api/explorer/masters?fen=rnbqkbnr%2Fpppppppp%2F8%2F8%2F8%2F8%2FPPPPPPPP%2FRNBQKBNR+w+KQkq+-+0+1&play=&since=1952&until=2026');
        expect(res.statusCode, res.body).toBe(200);
        expect(res.headers['x-outpost-source']).toBe('reference');
        const r = res.json<ExplorerMastersResponse>();
        expect([r.white, r.draws, r.black]).toEqual([1, 1, 1]);
        expect(upstreamCalls).toEqual([]);
        // Also under a filtered base, as lila resolves './masters' against it.
        const f = await inject(`/api/explorer/f/${encodeFiltersSegment({ tc: ['classical'] })}/masters`);
        expect(f.json<ExplorerMastersResponse>().white).toBe(1);

        // topGames are resolvable through masters/pgn/:id.
        const top = r.topGames[0]!;
        const pgn = await inject(`/api/explorer/masters/pgn/${top.id}`);
        expect(pgn.statusCode).toBe(200);
        expect(pgn.headers['content-type']).toMatch(/^application\/x-chess-pgn/);
        expect(pgn.body).toContain(`[White "W r3"]`);
        expect(pgn.body).toContain('[Result "1/2-1/2"]');
        expect(pgn.body).toContain('[WhiteElo "2800"]');
        expect(pgn.body).toContain('[WhiteTitle "GM"]');
        expect(pgn.body).toContain('[Date "2025.03.15"]');
        expect(pgn.body.trim().endsWith('1. d4 Nf6 2. c4 1/2-1/2')).toBe(true);
      } finally {
        writeSettings(t.db, { mastersSource: 'lichess' });
      }
    });

    it('falls back to Lichess when the configured database is gone', async () => {
      writeSettings(t.db, { mastersSource: 'reference:987654' });
      upstreamCalls = [];
      try {
        const res = await inject('/api/explorer/masters?play=e2e4');
        expect(res.statusCode).toBe(200);
        expect(res.headers['x-outpost-source']).toBe('lichess');
        expect(upstreamCalls).toHaveLength(1);
      } finally {
        writeSettings(t.db, { mastersSource: 'lichess' });
      }
    });

    it('serves op<id> PGNs only for databases the viewer may read', async () => {
      expect((await inject(`/api/explorer/masters/pgn/op${ids.d1}`)).statusCode).toBe(404);
      const own = await inject(`/api/explorer/masters/pgn/op${ids.d1}`, owner);
      expect(own.statusCode).toBe(200);
      expect(own.body).toContain('[White "Me"]');
      // Lichess / Chess.com games have no database: not masters games.
      expect((await inject(`/api/explorer/masters/pgn/op${ids.p1}`, owner)).statusCode).toBe(404);
      expect((await inject('/api/explorer/masters/pgn/op999999')).statusCode).toBe(404);
      expect((await inject('/api/explorer/masters/pgn/not-an-id')).statusCode).toBe(400);
    });
  });

  describe('query plans and scans', () => {
    const book = getOpeningBook();
    const lines = ['', 'e2e4', 'e2e4,e7e5', 'e2e4,e7e5,g1f3', 'd2d4', 'g1f3,g8f6', 'e2e4,c7c5'];
    const viewer = () => ({ id: ownerId, username: 'olga', role: 'user' as const, totpEnabled: false, prefs: {} as never });
    const sets = () => [
      { set: resolveGameSet(t.db, { kind: 'profile', slug: 'alice' }, viewer()), colors: ['white', 'black', null] as const },
      { set: resolveGameSet(t.db, { kind: 'db', databaseId: gamesDb }, viewer()), colors: ['white', 'black'] as const },
      { set: resolveGameSet(t.db, { kind: 'ref', fideId: '99999902' }, viewer()), colors: ['white', null] as const },
      { set: referenceGameSet(t.db, null, null), colors: [null] as const },
      { set: referenceGameSet(t.db, refB, null), colors: [null] as const },
    ];

    /**
     * The straightforward answer in JS: every (set row, position row) pair, first occurrence per game
     * (one row per game), then per-move sums and the most recent games.
     */
    const naive = (q: PositionQuery) => {
      const from = q.set.from(q.color);
      const rows = t.db.all<{ game_id: Id; color: 'w' | 'b'; outcome: 'w' | 'd' | 'l'; rating: number | null; opp_rating: number | null; ended_at: number | null; ply: number; next_uci: string | null }>(
        `SELECT pg.game_id, pg.color, pg.outcome, pg.rating, pg.opp_rating, pg.ended_at, p.ply, p.next_uci
           FROM ${from.sql} JOIN positions p ON p.game_id = pg.game_id AND p.pos_key = ? WHERE ${q.where.sql}
          ORDER BY pg.game_id, p.ply`,
        [...from.params, q.key, ...q.where.params],
      );
      const first = new Map<Id, (typeof rows)[number]>();
      for (const r of rows) if (!first.has(r.game_id)) first.set(r.game_id, r);
      const moves = new Map<string, { uci: string; games: number; white: number; draws: number; black: number; oppN: number; oppSum: number }>();
      let ended = 0;
      for (const r of first.values()) {
        if (r.next_uci === null) {
          ended++;
          continue;
        }
        const m = moves.get(r.next_uci) ?? { uci: r.next_uci, games: 0, white: 0, draws: 0, black: 0, oppN: 0, oppSum: 0 };
        m.games++;
        if (r.outcome === 'd') m.draws++;
        else if ((r.outcome === 'w') === (r.color === 'w')) m.white++;
        else m.black++;
        if (r.opp_rating !== null) {
          m.oppN++;
          m.oppSum += r.opp_rating;
        }
        moves.set(r.next_uci, m);
      }
      const recent = [...first.values()]
        .sort((a, b) => (b.ended_at ?? -1e18) - (a.ended_at ?? -1e18) || b.game_id - a.game_id)
        .map(r => r.game_id);
      // A game listed for two of the profile's accounts counts once, from either side: only the
      // absolute results are comparable then.
      const sided = !q.set.multiRow(q.color);
      const shown = [...moves.values()].map(m => (sided ? m : { ...m, oppN: 0, oppSum: 0 }));
      return { games: first.size, ended, moves: shown.sort((a, b) => (a.uci < b.uci ? -1 : 1)), recent };
    };
    const comparable = (r: ScanResult, q: PositionQuery) =>
      r.moves
        .map(m => ({ uci: m.uci, games: m.games, white: m.white, draws: m.draws, black: m.black, oppN: m.oppN, oppSum: m.oppSum }))
        .map(m => (q.set.multiRow(q.color) ? { ...m, oppN: 0, oppSum: 0 } : m))
        .sort((a, b) => (a.uci < b.uci ? -1 : 1));

    it('scans give the straightforward answer with both plans and any slicing', async () => {
      for (const { set, colors } of sets()) {
        for (const color of colors) {
          // The colour as the explorers pass it: a condition for player_games, an arm for derived sets.
          const where = setConditions(set, {}, NO_RESTRICTIONS, { color });
          for (const line of lines) {
            const q: PositionQuery = { set, where, key: resolvePosition(undefined, line, book).key, color };
            const want = naive(q);
            const label = `${set.cacheKey} ${color} ${line}`;
            for (const plan of ['set', 'position', undefined] as const) {
              for (const span of [1, 2, 7, undefined]) {
                const r = await scanPosition(t.db, q, { moves: true, count: true, list: { order: 'recent', limit: 50, withMove: false }, plan, span });
                expect(comparable(r, q), `${label} ${plan} ${span}`).toEqual(want.moves);
                expect([r.games, r.ended], label).toEqual([want.games, want.ended]);
                expect(r.list.map(h => h.gameId), label).toEqual(want.recent);
                // Count-only and list-only scans (one use of the hits: no scratch table).
                expect((await scanPosition(t.db, q, { count: true, plan, span })).games, label).toBe(want.games);
                const listOnly = await scanPosition(t.db, q, { list: { order: 'recent', limit: 2, withMove: false }, plan, span });
                expect(listOnly.list.map(h => h.gameId), label).toEqual(want.recent.slice(0, 2));
              }
              if (plan) {
                const direct = gamesPageDirect(t.db, q, { offset: 1, limit: 2 }, plan);
                expect(direct.map(h => h.gameId), `${label} direct ${plan}`).toEqual(want.recent.slice(1, 3));
              }
            }
          }
        }
      }
    });

    it('counts a game once at a position it reaches twice (first occurrence)', async () => {
      const db = t.db;
      const repDb = createDatabase(db, { name: 'repetitions', kind: 'games', ownerId });
      // Nf3 Nf6 Ng1 Ng8 returns to the start: first visit continues 1. Nf3, the second 3. e4.
      insertGame(db, testGame({ origin: 'pgn', originId: `${repDb}:rep`, databaseId: repDb, moves: sans('Nf3 Nf6 Ng1 Ng8 e4 e5'), timeClass: 'unknown' }));
      const set = resolveGameSet(db, { kind: 'db', databaseId: repDb }, viewer());
      const q: PositionQuery = { set, where: setConditions(set, {}, NO_RESTRICTIONS, { color: 'white' }), key: resolvePosition(undefined, '', book).key, color: 'white' };
      for (const plan of ['set', 'position'] as const) {
        const r = await scanPosition(db, q, { moves: true, plan });
        expect(r.moves.map(m => [m.uci, m.games]), plan).toEqual([['g1f3', 1]]);
      }
    });

    it('drops moves that are not legal at the position, and their games', async () => {
      const set = referenceGameSet(t.db, null, null);
      const q: PositionQuery = { set, where: setConditions(set, {}, NO_RESTRICTIONS, { color: null }), key: resolvePosition(undefined, '', book).key, color: null };
      for (const plan of ['set', 'position'] as const) {
        const r = await scanPosition(t.db, q, { moves: true, list: { order: 'rating', limit: 15, withMove: true }, legal: uci => uci !== 'e2e4', plan });
        expect(r.moves.map(m => m.uci)).toEqual(['d2d4']);
        expect(r.list.map(h => h.nextUci)).toEqual(['d2d4']);
        const listOnly = await scanPosition(t.db, q, { list: { order: 'rating', limit: 15, withMove: true }, legal: uci => uci !== 'e2e4', plan });
        expect(listOnly.list.map(h => h.nextUci)).toEqual(['d2d4']);
      }
    });

    it('yields to the event loop between slices and stops when cancelled', async () => {
      const set = referenceGameSet(t.db, null, null);
      const q: PositionQuery = { set, where: setConditions(set, {}, NO_RESTRICTIONS, { color: null }), key: resolvePosition(undefined, '', book).key, color: null };
      let ranMeanwhile = false;
      const scan = scanPosition(t.db, q, { moves: true, span: 1, plan: 'set' });
      setImmediate(() => {
        ranMeanwhile = true;
      });
      await scan;
      expect(ranMeanwhile).toBe(true);

      const controller = new AbortController();
      const cancelled = scanPosition(t.db, q, { moves: true, span: 1, plan: 'set', signal: controller.signal });
      controller.abort();
      await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('lets the smaller side drive (set size vs the position’s rows)', async () => {
      const start = resolvePosition(undefined, '', book).key;
      const rare = resolvePosition(undefined, 'e2e4,e7e5,g1f3,b8c6', book).key;
      const profile = resolveGameSet(t.db, { kind: 'profile', slug: 'alice' }, viewer());
      const q = (set: GameSet, key: number): PositionQuery => ({ set, where: setConditions(set, {}, NO_RESTRICTIONS, { color: null }), key, color: null });
      // Every game reaches the start: more position rows than profile rows → walk the profile.
      expect(await choosePlan(t.db, q(profile, start))).toMatchObject({ plan: 'set' });
      // One game (r1) reaches 2…Nc6 → walk the position.
      expect(await choosePlan(t.db, q(referenceGameSet(t.db, null, null), rare))).toEqual({ plan: 'position', rows: 1 });
      expect(await positionRowsUpTo(t.db, start, 3)).toBe(3);
    });

    it('reads reference databases through the covering index in both plans (EXPLAIN QUERY PLAN)', () => {
      const set = referenceGameSet(t.db, null, null);
      const where = setConditions(set, {}, NO_RESTRICTIONS, { color: null });
      for (const plan of ['set', 'position'] as const) {
        const h = hitsSql({ set, where, key: 1, color: null }, plan, 1, 1000);
        const steps = t.db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${h.sql}`, h.params).map(r => r.detail);
        expect(steps.join('\n'), plan).toMatch(/positions_key/);
        // Each slice reads only its id range, also without ANALYZE statistics (a fresh database).
        expect(steps.join('\n'), plan).toMatch(
          plan === 'set' ? /COVERING INDEX games_explorer_db \(database_id=\? AND id>\? AND id<\?\)/ : /positions_key \(pos_key=\? AND game_id>\? AND game_id<\?\)/,
        );
        expect(steps.some(s => /^SCAN (p|positions|g)\b/.test(s)), steps.join('\n')).toBe(false);
      }
    });
  });

  describe('result cache', () => {
    it('keeps reference results across unrelated writes and drops them when the database changes', async () => {
      const local = createLocalExplorer({ db: t.db, openingsDir: t.config.openingsDir });
      const first = await local.reference({ viewer: null, databaseId: refA, filters: {} });
      expect(await local.reference({ viewer: null, databaseId: refA, filters: {} })).toBe(first);
      // A profile sync and an import into another database leave it cached.
      insertGame(t.db, testGame({ originId: 'cache-unrelated', moves: sans('e4 e5') }));
      insertGame(t.db, testGame({ origin: 'reference', originId: `${refB}:cache-other`, databaseId: refB, moves: sans('e4'), timeClass: 'classical' }));
      expect(await local.reference({ viewer: null, databaseId: refA, filters: {} })).toBe(first);
      // A game added to it (or removed) is a new version.
      const added = insertGame(t.db, testGame({ origin: 'reference', originId: `${refA}:cache-new`, databaseId: refA, moves: sans('d4'), timeClass: 'classical' })).gameId;
      const second = await local.reference({ viewer: null, databaseId: refA, filters: {} });
      expect(second).not.toBe(first);
      expect(second.white + second.draws + second.black).toBe(first.white + first.draws + first.black + 1);
      t.db.run('DELETE FROM games WHERE id = ?', [added]);
      const third = await local.reference({ viewer: null, databaseId: refA, filters: {} });
      expect(third).not.toBe(second);
      expect(third).toEqual(first);
      // Profiles are never cached (no version), but identical requests in flight share one scan.
      const alice = { player: 'alice', color: 'white' as const, filters: {}, viewer: null };
      const [a, b] = await Promise.all([local.player(alice), local.player(alice)]);
      expect(a).toBe(b);
      expect(await local.player(alice)).not.toBe(a);
      expect(local.stats()).toMatchObject({ inFlight: 0, running: 0, queued: 0 });
    });

    it('keeps explorer_db_stats in step with the games table', () => {
      const db = t.db;
      const stats = (id: Id) => db.get<{ games: number; changes: number }>('SELECT games, changes FROM explorer_db_stats WHERE database_id = ?', [id]);
      const real = (id: Id) => db.value<number>('SELECT count(*) FROM games WHERE database_id = ?', [id]);
      for (const id of [refA, refB, gamesDb]) expect(stats(id)?.games, String(id)).toBe(real(id));
      const tmp = createDatabase(db, { name: 'tmp', kind: 'reference' });
      const g = insertGame(db, testGame({ origin: 'reference', originId: `${tmp}:x`, databaseId: tmp, moves: sans('c4') })).gameId;
      expect(stats(tmp)).toEqual({ games: 1, changes: 1 });
      db.run('UPDATE games SET white_rating = 2000 WHERE id = ?', [g]);
      expect(stats(tmp)).toEqual({ games: 1, changes: 2 });
      // Deleting the database cascades to its games; the counter follows.
      db.run('DELETE FROM databases WHERE id = ?', [tmp]);
      expect(stats(tmp)).toEqual({ games: 0, changes: 3 });
    });

    it('queues large scans for a slot and refuses when the queue is full', async () => {
      const local = createLocalExplorer({ db: t.db, openingsDir: t.config.openingsDir, maxConcurrentScans: 1, smallScanRows: 0 });
      const requests = ['', 'e2e4', 'd2d4'].map(play => local.reference({ viewer: null, databaseId: null, play, filters: {} }));
      expect(local.stats()).toMatchObject({ running: 1, queued: 2 });
      const results = await Promise.all(requests);
      expect(results.map(r => r.moves.length > 0)).toEqual([true, true, true]);
      expect(local.stats()).toMatchObject({ running: 0, queued: 0, inFlight: 0 });
      // A waiting request whose client leaves gives its place up.
      const controller = new AbortController();
      const first = local.reference({ viewer: null, databaseId: null, play: 'g1f3', filters: {} });
      const second = local.reference({ viewer: null, databaseId: null, play: 'c2c4', filters: {}, signal: controller.signal });
      expect(local.stats().queued).toBe(1);
      controller.abort();
      await expect(second).rejects.toMatchObject({ statusCode: 499 });
      expect(local.stats().queued).toBe(0);
      await first;
    });
  });
});
