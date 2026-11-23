/**
 * /api/explorer/games, /api/explorer/reference, the reference-backed masters explorer and the two
 * query plans of the local explorers.
 */
import type { DbGameRow, ExplorerGamesPage, ExplorerMastersResponse, GameRow, Id } from '@outpost/shared/api';
import { encodeFiltersSegment } from '@outpost/shared/filters';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getOpeningBook } from '../src/chess/openings.ts';
import { insertGame, pgnSourceKey } from '../src/chess/store.ts';
import { referenceGameSet, resolveGameSet } from '../src/explorer/gameSet.ts';
import { resolvePosition } from '../src/explorer/position.ts';
import { collectHits, gamesAtPosition, hitsQuery, setConditions } from '../src/explorer/query.ts';
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

  describe('query plans', () => {
    const book = getOpeningBook();
    const lines = ['', 'e2e4', 'e2e4,e7e5', 'e2e4,e7e5,g1f3', 'd2d4', 'g1f3,g8f6'];
    const sorted = <T extends { gameId: Id }>(xs: T[]) => [...xs].sort((a, b) => a.gameId - b.gameId);

    it('set-driven and position-driven plans find the same hits', () => {
      const viewer = { id: ownerId, username: 'olga', role: 'user' as const, totpEnabled: false, prefs: {} as never };
      const sets = [
        { set: resolveGameSet(t.db, { kind: 'profile', slug: 'alice' }, viewer), colors: ['white', 'black', null] as const },
        { set: resolveGameSet(t.db, { kind: 'db', databaseId: gamesDb }, viewer), colors: ['white', 'black'] as const },
        { set: resolveGameSet(t.db, { kind: 'ref', fideId: '99999902' }, viewer), colors: ['white', null] as const },
        { set: referenceGameSet(null), colors: [null] as const },
        { set: referenceGameSet(refB), colors: [null] as const },
      ];
      for (const { set, colors } of sets) {
        for (const color of colors) {
          const where = setConditions(set, {}, NO_RESTRICTIONS, { color: null });
          for (const line of lines) {
            const key = resolvePosition(undefined, line, book).key;
            const a = sorted(collectHits(t.db, set, where, key, color, 'set'));
            const b = sorted(collectHits(t.db, set, where, key, color, 'position'));
            expect(a, `${set.cacheKey} ${color} ${line}`).toEqual(b);
            const pa = gamesAtPosition(t.db, set, where, key, color, { offset: 0, limit: 50 }, 'set');
            const pb = gamesAtPosition(t.db, set, where, key, color, { offset: 0, limit: 50 }, 'position');
            expect(pa, `${set.cacheKey} ${color} ${line}`).toEqual(pb);
          }
        }
      }
    });

    it('uses the positions index in both plans (EXPLAIN QUERY PLAN)', () => {
      const set = referenceGameSet(null);
      const where = setConditions(set, {}, NO_RESTRICTIONS, { color: null });
      for (const plan of ['set', 'position'] as const) {
        const q = hitsQuery(t.db, set, where, 1, null, plan);
        const steps = t.db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${q.sql}`, q.params).map(r => r.detail);
        expect(steps.join('\n')).toMatch(/positions_key/);
        expect(steps.some(s => /^SCAN p\b/.test(s))).toBe(false);
      }
    });
  });
});
