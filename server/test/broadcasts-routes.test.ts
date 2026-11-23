import { readFileSync } from 'node:fs';
import type { BroadcastRound, BroadcastsResponse, BroadcastTour } from '@outpost/shared/api';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseTop, roundGamePgn, standardLastMove, toBroadcastsResponse } from '../src/broadcasts/index.ts';
import { BROADCAST_LIMITS, RequestBudget, TtlCache } from '../src/broadcasts/service.ts';
import { notFound } from '../src/http/errors.ts';
import { autoImportFinishedRounds, startBroadcastAutoImport } from '../src/reference/autoImport.ts';
import { ensureBroadcastDatabase } from '../src/reference/databases.ts';
import { referencePlayerByFideId } from '../src/reference/players.ts';
import { writeSettings } from '../src/settings.ts';
import { createUserSession, makeTestApp, type TestApp } from './helpers.ts';

const FIXTURES = new URL('./fixtures/reference/', import.meta.url);
const text = (name: string): string => readFileSync(new URL(name, FIXTURES), 'utf8');

/** Synthetic `/api/broadcast/top` pages (shape checked against lichess.org on 2026-11-23). */
const TOP = text('broadcast-top.json');
const TOP_PAGE_2 = text('broadcast-top-page2.json');
const TOUR = text('broadcast-tour.json');
const TOUR_DONE = text('broadcast-tour-done.json');
const ROUND = text('broadcast-round.json');
const ROUND_PGN = text('round-Rnd5EEEE.pgn');
/** TourNEXT with its two rounds, as `GET /api/broadcast/TourNEXT` would answer. */
const TOUR_NEXT = (() => {
  const e = JSON.parse(TOP).active[0];
  return JSON.stringify({ tour: e.tour, rounds: [e.roundToLink, e.round], defaultRoundId: e.roundToLink.id });
})();

interface Call {
  url: string;
  auth: string | null;
  accept: string | null;
}

const json = (body: string) => new Response(body, { headers: { 'content-type': 'application/json' } });

/** A body that sends `first` and then fails (a connection that breaks off) or never ends. */
function brokenBody(first: string, mode: 'error' | 'stall'): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(first));
      if (mode === 'error') controller.error(new TypeError('terminated'));
    },
  });
  return new Response(stream, { headers: { 'content-type': 'application/json' } });
}

/** Fake lichess.org. `overrides` (by path + query) replace or add answers. */
function lichessFake(calls: Call[], overrides: Record<string, () => Response> = {}): typeof globalThis.fetch {
  return async (input, init = {}) => {
    const url = new URL(String(input));
    const headers = new Headers(init.headers);
    calls.push({ url: url.href, auth: headers.get('authorization'), accept: headers.get('accept') });
    if (url.host !== 'lichess.org') throw new Error(`unexpected host ${url.host}`);
    const override = overrides[url.pathname + url.search] ?? overrides[url.pathname];
    if (override) return override();
    const p = url.pathname;
    if (p === '/api/broadcast/top') return json(url.searchParams.get('page') === '2' ? TOP_PAGE_2 : TOP);
    if (p === '/api/broadcast/TourLIVE') return json(TOUR);
    if (p === '/api/broadcast/TourDONE') return json(TOUR_DONE);
    if (p === '/api/broadcast/TourNEXT') return json(TOUR_NEXT);
    if (p === '/api/broadcast/-/-/RndLV002') return json(ROUND);
    if (p === '/api/broadcast/round/RndLV002.pgn') return new Response(ROUND_PGN, { headers: { 'content-type': 'application/x-chess-pgn' } });
    if (p === '/api/broadcast/-/-/BrokenJs') return json('{"oops":');
    if (p === '/api/broadcast/-/-/Teapot42') return new Response('no', { status: 500 });
    return new Response('{"error":"Not found"}', { status: 404 });
  };
}

describe('broadcast routes', () => {
  let t: TestApp;
  let cookie: string;
  const calls: Call[] = [];

  beforeAll(async () => {
    t = await makeTestApp({ fetch: lichessFake(calls), env: { LICHESS_TOKEN: 'lip_testtoken' } });
    cookie = createUserSession(t.db, { username: 'viewer' }).cookie;
  });
  afterAll(async () => {
    await t.close();
  });
  afterEach(() => {
    calls.length = 0;
    vi.useRealTimers();
  });

  const get = (url: string) => t.app.inject({ url, headers: { cookie } });

  it('needs a viewer', async () => {
    expect((await t.app.inject({ url: '/api/broadcasts' })).statusCode).toBe(401);
    expect(calls).toEqual([]);
  });

  it('lists official broadcasts from the top list: live first, then upcoming, finished ones as recent', async () => {
    const res = await get('/api/broadcasts');
    expect(res.statusCode).toBe(200);
    const body = res.json<BroadcastsResponse>();
    expect(body.active.map(b => [b.tour.id, b.live, b.defaultRoundId])).toEqual([
      ['TourLIVE', true, 'RndLV002'],
      ['TourNEXT', false, 'RndNX001'],
    ]);
    expect(body.upcoming?.map(b => [b.tour.id, b.defaultRoundId])).toEqual([['TourUPCO', 'RndUP001']]);
    expect(body.recent.map(b => [b.tour.id, b.defaultRoundId, b.rounds.map(r => [r.id, r.finished])])).toEqual([
      ['TourDONE', 'RndDN002', [['RndDN002', true]]],
      ['TourOLD1', 'RndOL001', [['RndOL001', true]]],
    ]);
    expect(body.active[0]!.tour).toEqual({
      id: 'TourLIVE',
      name: 'Live Test Open | Masters',
      slug: 'live-test-open-masters',
      tier: 4,
      dates: [1795000000000, 1795600000000],
      url: 'https://lichess.org/broadcast/live-test-open-masters/TourLIVE',
      description: 'Synthetic test tournament.',
      info: {
        format: '8-player round robin',
        tc: '90 min + 30 sec / move',
        fideTC: 'standard',
        location: 'Testville',
        players: 'Alpha, Beta',
        website: 'https://example.org/',
      },
    });
    expect(body.active[0]!.rounds).toEqual([
      { id: 'RndLV002', name: 'Round 2', slug: 'round-2', startsAt: 1795086400000, finished: false, ongoing: true, url: 'https://lichess.org/broadcast/live-test-open-masters/round-2/RndLV002' },
    ]);
    // Between rounds: the latest round with games first (opened by default), then the next one.
    expect(body.active[1]!.rounds.map(r => [r.id, r.finished, r.ongoing])).toEqual([
      ['RndNX001', true, false],
      ['RndNX002', false, false],
    ]);
    expect(calls).toEqual([{ url: 'https://lichess.org/api/broadcast/top?page=1', auth: 'Bearer lip_testtoken', accept: 'application/json' }]);
    // Cached for a minute.
    await get('/api/broadcasts');
    expect(calls).toHaveLength(1);
  });

  it('maps a tour', async () => {
    const res = await get('/api/broadcasts/tour/TourLIVE');
    expect(res.statusCode).toBe(200);
    const tour = res.json<BroadcastTour>();
    expect(tour).toMatchObject({ tour: { id: 'TourLIVE' }, defaultRoundId: 'RndLV002', live: true });
    expect(tour.rounds).toHaveLength(3);
    expect((await get('/api/broadcasts/tour/Missing1')).json().error.code).toBe('not_found');
    expect((await get('/api/broadcasts/tour/bad')).json().error.code).toBe('validation');
  });

  it('maps round previews: players, titles, ratings, feds, clocks, FEN, last move, status', async () => {
    const res = await get('/api/broadcasts/round/RndLV002');
    expect(res.statusCode).toBe(200);
    const round = res.json<BroadcastRound>();
    expect(round.tour).toEqual({ id: 'TourLIVE', name: 'Live Test Open | Masters', slug: 'live-test-open-masters' });
    expect(round.round).toMatchObject({ id: 'RndLV002', ongoing: true, finished: false });
    expect(round.fetchedAt).toEqual(expect.any(Number));
    expect(round.games).toEqual([
      {
        id: 'Chap0001',
        name: 'Alpha, Test - Beta, Test',
        white: { name: 'Alpha, Test', title: 'GM', rating: 2650, fideId: '900001', fed: 'NOR', clock: 5432 },
        black: { name: 'Beta, Test', title: 'IM', rating: 2480, fideId: '900002', fed: 'ESP', clock: 6123 },
        fen: 'r1bq1rk1/pppp1ppp/2n2n2/2b1p3/2B1P3/3P1N2/PPP2PPP/RNBQ1RK1 b - - 0 5',
        lastMove: 'e1g1',
        status: '*',
        thinkTime: 42,
      },
      {
        id: 'Chap0002',
        name: 'Gamma, Test - Delta, Test',
        white: { name: 'Gamma, Test', title: null, rating: 2400, fideId: '900003', fed: null, clock: 1 },
        black: { name: 'Delta, Test', title: null, rating: 2390, fideId: '900004', fed: null, clock: null },
        fen: '8/8/4k3/8/8/4K3/8/8 w - - 10 60',
        lastMove: 'd7e6',
        status: '1/2-1/2',
        thinkTime: null,
      },
      {
        id: 'Chap0003',
        name: '2162 Club Player - Another Player',
        white: { name: '2162 Club Player', title: null, rating: null, fideId: null, fed: null, clock: null },
        black: { name: 'Another Player', title: null, rating: null, fideId: null, fed: null, clock: null },
        fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        lastMove: null,
        status: '*',
        thinkTime: null,
      },
      {
        id: 'Chap0004',
        name: 'Rook, Mover - Other, Side',
        white: { name: 'Rook, Mover', title: null, rating: null, fideId: null, fed: null, clock: null },
        black: { name: 'Other, Side', title: null, rating: null, fideId: null, fed: null, clock: null },
        fen: 'rnbqkbnr/pppp1ppp/8/4p3/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 2',
        lastMove: 'e1h1',
        status: '0-1',
        thinkTime: null,
      },
    ]);
    expect(calls.map(c => [c.url, c.auth])).toEqual([['https://lichess.org/api/broadcast/-/-/RndLV002', 'Bearer lip_testtoken']]);
  });

  it('caches round previews for 5 seconds and shares in-flight requests', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2030, 0, 1));
    const svc = await makeTestApp({ fetch: lichessFake(calls), env: { LICHESS_TOKEN: 'lip_testtoken' } });
    try {
      const c = createUserSession(svc.db, { username: 'v' }).cookie;
      const r = () => svc.app.inject({ url: '/api/broadcasts/round/RndLV002', headers: { cookie: c } });
      await Promise.all([r(), r(), r()]);
      expect(calls).toHaveLength(1);
      vi.setSystemTime(Date.UTC(2030, 0, 1) + 4_000);
      await r();
      expect(calls).toHaveLength(1);
      vi.setSystemTime(Date.UTC(2030, 0, 1) + 5_500);
      const fresh = (await r()).json<BroadcastRound>();
      expect(calls).toHaveLength(2);
      expect(fresh.fetchedAt).toBe(Date.UTC(2030, 0, 1) + 5_500);
    } finally {
      await svc.close();
    }
  });

  it('records federations of indexed players seen in round previews', async () => {
    const svc = await makeTestApp({ fetch: lichessFake(calls), env: { LICHESS_TOKEN: 'lip_testtoken' } });
    try {
      const dbId = ensureBroadcastDatabase(svc.db);
      svc.db.run(
        `INSERT INTO reference_players (fide_id, database_id, name_key, name, search_name, games, updated_at)
         VALUES ('900001', NULL, 'alpha, test', 'Alpha, Test', 'alpha test', 1, 0)`,
      );
      const c = createUserSession(svc.db, { username: 'v' }).cookie;
      await svc.app.inject({ url: '/api/broadcasts/round/RndLV002', headers: { cookie: c } });
      expect(referencePlayerByFideId(svc.db, '900001')?.federation).toBe('NOR');
      expect(referencePlayerByFideId(svc.db, '900002')).toBeNull(); // not indexed: nothing created
      expect(dbId).toBeGreaterThan(0);
    } finally {
      await svc.close();
    }
  });

  it('serves the round PGN', async () => {
    const res = await get('/api/broadcasts/round/RndLV002.pgn');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/x-chess-pgn; charset=utf-8');
    expect(res.headers['content-disposition']).toBe('attachment; filename="broadcast-RndLV002.pgn"');
    expect(res.body).toBe(ROUND_PGN);
    expect(calls.map(c => c.url)).toEqual(['https://lichess.org/api/broadcast/round/RndLV002.pgn?clocks=true&comments=true']);
  });

  it('serves one game of the round PGN without another upstream call (decision 17)', async () => {
    const res = await get('/api/broadcasts/round/RndLV002/game/Game0009.pgn');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toBe('application/x-chess-pgn; charset=utf-8');
    expect(res.headers['content-disposition']).toBe('attachment; filename="broadcast-RndLV002-Game0009.pgn"');
    expect(res.body.match(/^\[Event /gm)).toHaveLength(1);
    expect(res.body).toContain('[GameURL "https://lichess.org/broadcast/outpost-test-open-2026/round-3/Rnd5EEEE/Game0009"]');
    expect(res.body.endsWith('\n')).toBe(true);
    expect(ROUND_PGN).toContain(res.body.trim());
    // The first and the last game of the round, then an unknown one: the round PGN is fetched once.
    const ids = [...ROUND_PGN.matchAll(/\[GameURL "[^"]*\/([A-Za-z0-9]{8})"\]/g)].map(m => m[1]!);
    for (const id of [ids[0]!, ids.at(-1)!]) {
      const one = await get(`/api/broadcasts/round/RndLV002/game/${id}.pgn`);
      expect(one.statusCode).toBe(200);
      expect(one.body).toContain(`/${id}"]`);
      expect(one.body.match(/^\[Event /gm)).toHaveLength(1);
    }
    expect((await get('/api/broadcasts/round/RndLV002/game/Nowhere1.pgn')).statusCode).toBe(404);
    expect((await get('/api/broadcasts/round/RndLV002/game/bad-id.pgn')).statusCode).toBe(400);
    // At most the round PGN itself (it may still be cached from the test above).
    expect(calls.length).toBeLessThanOrEqual(1);
    expect(calls.every(c => c.url === 'https://lichess.org/api/broadcast/round/RndLV002.pgn?clocks=true&comments=true')).toBe(true);
  });

  it('cuts games by their URL tags, keeping clocks and comments', () => {
    const pgn = [
      '[Event "A"]',
      '[Site "https://lichess.org/broadcast/t/r/Round001/GameAAAA"]',
      '',
      '1. e4 { [%clk 1:30:00] }',
      '[%evp 1,2] 1-0',
      '',
      '',
      '[Event "B"]',
      '[GameURL "https://lichess.org/broadcast/t/r/Round001/GameBBBB"]',
      '',
      '1. d4 { [%clk 1:29:59] } *',
    ].join('\r\n');
    expect(roundGamePgn(pgn, 'GameAAAA')).toBe('[Event "A"]\n[Site "https://lichess.org/broadcast/t/r/Round001/GameAAAA"]\n\n1. e4 { [%clk 1:30:00] }\n[%evp 1,2] 1-0\n');
    expect(roundGamePgn(pgn, 'GameBBBB')).toBe('[Event "B"]\n[GameURL "https://lichess.org/broadcast/t/r/Round001/GameBBBB"]\n\n1. d4 { [%clk 1:29:59] } *\n');
    expect(roundGamePgn(pgn, 'Round001')).toBeNull();
    expect(roundGamePgn(pgn, 'GameCCCC')).toBeNull();
    expect(roundGamePgn('', 'GameAAAA')).toBeNull();
  });

  it('answers clean errors: unknown rounds 404 (remembered a minute), bad ids 400, upstream failures 502', async () => {
    expect((await get('/api/broadcasts/round/Missing1')).statusCode).toBe(404);
    expect((await get('/api/broadcasts/round/Missing1')).statusCode).toBe(404);
    expect((await get('/api/broadcasts/round/Missing1.pgn')).statusCode).toBe(404);
    expect((await get('/api/broadcasts/tour/Missing2')).statusCode).toBe(404);
    expect((await get('/api/broadcasts/tour/Missing2')).statusCode).toBe(404);
    // Unknown ids reach Lichess once each.
    expect(calls.map(c => new URL(c.url).pathname)).toEqual([
      '/api/broadcast/-/-/Missing1',
      '/api/broadcast/round/Missing1.pgn',
      '/api/broadcast/Missing2',
    ]);
    expect((await get('/api/broadcasts/round/not-an-id')).statusCode).toBe(400);
    expect((await get('/api/broadcasts/round/..%2F..%2Fx')).statusCode).toBe(400);
    const broken = await get('/api/broadcasts/round/BrokenJs');
    expect(broken.statusCode).toBe(502);
    expect(broken.json().error.code).toBe('upstream_error');
    const down = await get('/api/broadcasts/round/Teapot42');
    expect(down.statusCode).toBe(502);
  });

  it('turns body failures into 503/502, never 500, and gives up on a stalled body', async () => {
    const overrides: Record<string, () => Response> = {
      '/api/broadcast/top': () => brokenBody('{"active":[', 'error'),
      '/api/broadcast/round/BrokenPg.pgn': () => brokenBody('[Event "x"]\n', 'error'),
      '/api/broadcast/round/HugePgn1.pgn': () => new Response('x', { headers: { 'content-length': String(9 * 1024 * 1024) } }),
      '/api/broadcast/-/-/Stalled1': () => brokenBody('{"round":', 'stall'),
    };
    const svc = await makeTestApp({ fetch: lichessFake(calls, overrides), env: { LICHESS_TOKEN: 'lip_testtoken' } });
    const deadline = BROADCAST_LIMITS.deadlineMs;
    try {
      const c = createUserSession(svc.db, { username: 'v' }).cookie;
      const r = (url: string) => svc.app.inject({ url, headers: { cookie: c } });
      const list = await r('/api/broadcasts');
      expect(list.statusCode).toBe(503);
      expect(list.json().error).toMatchObject({ code: 'upstream_unavailable', details: { reason: 'network', host: 'lichess.org' } });
      expect((await r('/api/broadcasts/round/BrokenPg.pgn')).json().error).toMatchObject({ code: 'upstream_unavailable' });
      const huge = await r('/api/broadcasts/round/HugePgn1.pgn');
      expect(huge.statusCode).toBe(502);
      expect(huge.json().error.message).toMatch(/larger than/);
      BROADCAST_LIMITS.deadlineMs = 100;
      const started = Date.now();
      const stalled = await r('/api/broadcasts/round/Stalled1');
      expect(stalled.statusCode).toBe(503);
      expect(stalled.json().error.details.reason).toBe('timeout');
      expect(Date.now() - started).toBeLessThan(5_000);
      // Failures are not cached: the next request asks again.
      const before = calls.length;
      await r('/api/broadcasts');
      expect(calls.length).toBe(before + 1);
    } finally {
      BROADCAST_LIMITS.deadlineMs = deadline;
      await svc.close();
    }
  });

  it('keeps cache misses within an instance-wide budget per minute', async () => {
    const budget = BROADCAST_LIMITS.upstreamPerMinute;
    const svc = await makeTestApp({ fetch: lichessFake(calls), env: { LICHESS_TOKEN: 'lip_testtoken' } });
    BROADCAST_LIMITS.upstreamPerMinute = 3;
    try {
      const c = createUserSession(svc.db, { username: 'v' }).cookie;
      const r = (url: string) => svc.app.inject({ url, headers: { cookie: c } });
      for (const id of ['Unknown1', 'Unknown2', 'Unknown3']) expect((await r(`/api/broadcasts/round/${id}`)).statusCode).toBe(404);
      const over = await r('/api/broadcasts/round/Unknown4');
      expect(over.statusCode).toBe(503);
      expect(over.json().error).toMatchObject({ code: 'upstream_unavailable', details: { reason: 'budget', retryAt: expect.any(Number) } });
      // Cached answers cost nothing.
      expect((await r('/api/broadcasts/round/Unknown1')).statusCode).toBe(404);
      expect(calls).toHaveLength(3);
    } finally {
      BROADCAST_LIMITS.upstreamPerMinute = budget;
      await svc.close();
    }
  });

  it('fails with 503 no_token when no Lichess token is configured', async () => {
    const noToken = await makeTestApp({ fetch: lichessFake(calls) });
    try {
      const c = createUserSession(noToken.db, { username: 'v' }).cookie;
      for (const url of ['/api/broadcasts', '/api/broadcasts/tour/TourLIVE', '/api/broadcasts/round/RndLV002', '/api/broadcasts/round/RndLV002.pgn']) {
        const res = await noToken.app.inject({ url, headers: { cookie: c } });
        expect(res.statusCode, url).toBe(503);
        expect(res.json().error).toMatchObject({ code: 'upstream_unavailable', details: { reason: 'no_token' } });
      }
      expect(calls).toEqual([]);
    } finally {
      await noToken.close();
    }
  });
});

describe('broadcast helpers', () => {
  it('normalises king-takes-rook castling only when the board shows castling', () => {
    expect(standardLastMove('e1h1', 'r1bq1rk1/8/8/8/8/8/8/RNBQ1RK1 b - - 0 5')).toBe('e1g1');
    expect(standardLastMove('e8a8', '2kr4/8/8/8/8/8/8/4K3 w - - 0 5')).toBe('e8c8');
    expect(standardLastMove('e1h1', '4k3/8/8/8/8/8/8/4K2R b - - 0 5')).toBe('e1h1'); // rook still on h1
    expect(standardLastMove('e2e4', 'whatever')).toBe('e2e4');
    expect(standardLastMove('zz', 'x')).toBeNull();
    expect(standardLastMove(undefined, 'x')).toBeNull();
  });

  it('maps the top list: dedupes tours, drops broken entries, refuses other shapes', () => {
    const tour = (id: string) => ({ id, name: id, slug: id.toLowerCase() });
    const top = parseTop({
      active: [{ tour: tour('TourAAAA'), round: { id: 'R1', name: 'Round 1', ongoing: true } }, { tour: { name: 'no id' } }, 'junk'],
      past: {
        currentPageResults: [
          { tour: tour('TourAAAA'), round: { id: 'R0', finished: true } },
          { tour: tour('TourBBBB'), round: null },
        ],
        nextPage: null,
      },
    });
    expect(top).not.toBeNull();
    const res = toBroadcastsResponse(top!);
    expect(res.active.map(b => [b.tour.id, b.live, b.defaultRoundId])).toEqual([['TourAAAA', true, 'R1']]);
    expect(res.recent.map(b => [b.tour.id, b.defaultRoundId, b.rounds])).toEqual([['TourBBBB', null, []]]);
    expect(res.upcoming).toEqual([]);
    expect(top!.nextPastPage).toBeNull();
    expect(parseTop([])).toBeNull();
    expect(parseTop({ tours: [] })).toBeNull();
  });

  it('TtlCache drops failures so the next call retries, and stays bounded', async () => {
    let n = 0;
    let now = 0;
    const cache = new TtlCache<number>(1000, { now: () => now, maxEntries: 2 });
    await expect(cache.get('k', async () => Promise.reject(new Error(`fail ${++n}`)))).rejects.toThrow('fail 1');
    expect(await cache.get('k', async () => ++n)).toBe(2);
    expect(await cache.get('k', async () => ++n)).toBe(2);
    await cache.get('a', async () => 10);
    await cache.get('b', async () => 11);
    expect(await cache.get('k', async () => ++n)).toBe(3); // evicted as the oldest
    now = 5000;
    expect(await cache.get('k', async () => ++n)).toBe(4); // expired
  });

  it('TtlCache keeps chosen failures (404s) for their own lifetime', async () => {
    let now = 0;
    let loads = 0;
    const cache = new TtlCache<number>(1000, { now: () => now, errorTtlMs: 60_000, cacheError: e => e instanceof Error && e.message === 'Not found' });
    const missing = () => {
      loads++;
      return Promise.reject(notFound());
    };
    await expect(cache.get('x', missing)).rejects.toThrow('Not found');
    now = 30_000;
    await expect(cache.get('x', missing)).rejects.toThrow('Not found');
    expect(loads).toBe(1);
    now = 61_000;
    await expect(cache.get('x', missing)).rejects.toThrow('Not found');
    expect(loads).toBe(2);
  });

  it('RequestBudget allows a number of calls per sliding minute', () => {
    let now = 0;
    const budget = new RequestBudget(() => 2, () => now);
    budget.take();
    now = 10_000;
    budget.take();
    expect(() => budget.take()).toThrow(/Too many broadcast requests/);
    now = 60_001;
    budget.take(); // the first call left the window
    expect(() => budget.take()).toThrow();
  });
});

describe('broadcast auto-import', () => {
  let t: TestApp;
  const calls: Call[] = [];
  const overrides: Record<string, () => Response> = {};
  // RndNX001 (TourNEXT), RndLV001 (TourLIVE) and RndDN002 (TourDONE) ended within the week before;
  // RndDN001 eight days before; TourOLD1 and TourOLD2 long ago.
  const now = 1795300000000;
  const paths = () => calls.map(c => new URL(c.url).pathname + new URL(c.url).search);

  beforeAll(async () => {
    t = await makeTestApp({ fetch: lichessFake(calls, overrides), env: { LICHESS_TOKEN: 'lip_testtoken' } });
  });
  afterAll(async () => {
    await t.close();
  });
  afterEach(() => {
    calls.length = 0;
    for (const k of Object.keys(overrides)) delete overrides[k];
  });

  const tick = (at = now) => autoImportFinishedRounds({ db: t.db, config: t.config, upstream: t.app.upstream, now: at });
  const labels = (jobs: Awaited<ReturnType<typeof tick>>) => jobs.map(j => j.label);

  it('does nothing unless the admin setting is on', async () => {
    expect(await tick()).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('queues the finished rounds of the last week from active and finished tours, at background priority', async () => {
    writeSettings(t.db, { broadcastAutoImport: true });
    const jobs = await tick(now);
    expect(jobs.map(j => [j.kind, j.lane, j.priority, j.label])).toEqual([
      ['broadcastRound', 'lichess', -10, 'Broadcast round RndNX001'],
      ['broadcastRound', 'lichess', -10, 'Broadcast round RndLV001'],
      ['broadcastRound', 'lichess', -10, 'Broadcast round RndDN002'],
    ]);
    // Finished tours are paged until a page has nothing recent; upcoming tours are not looked at.
    expect(paths()).toEqual([
      '/api/broadcast/top?page=1',
      '/api/broadcast/top?page=2',
      '/api/broadcast/TourNEXT',
      '/api/broadcast/TourLIVE',
      '/api/broadcast/TourDONE',
    ]);
    expect(calls.every(c => c.auth === 'Bearer lip_testtoken')).toBe(true);
    const dbId = ensureBroadcastDatabase(t.db);
    expect(JSON.parse(t.db.value<string>('SELECT payload_json FROM jobs WHERE id = ?', [jobs[0]!.id])!)).toEqual({ databaseId: dbId, roundId: 'RndNX001' });

    // Nothing changed in the list: only the list is read, nothing is queued twice.
    calls.length = 0;
    expect(await tick(now + 60_000)).toEqual([]);
    expect(paths()).toEqual(['/api/broadcast/top?page=1', '/api/broadcast/top?page=2']);
  });

  it("re-reads a tour when the list shows a change, e.g. a tour's last round finishing", async () => {
    t.db.run("UPDATE jobs SET status = 'done'");
    const top = JSON.parse(TOP);
    const live = JSON.parse(TOUR);
    // Round 2 of TourLIVE finished: the list moves on to round 3 and links round 2.
    live.rounds[1] = { ...live.rounds[1], ongoing: undefined, finished: true, finishedAt: now + 1000 };
    top.active[1].round = live.rounds[2];
    top.active[1].roundToLink = live.rounds[1];
    overrides['/api/broadcast/top?page=1'] = () => json(JSON.stringify(top));
    overrides['/api/broadcast/TourLIVE'] = () => json(JSON.stringify(live));
    const dbId = ensureBroadcastDatabase(t.db);
    t.db.run(
      `INSERT INTO reference_broadcast_rounds (database_id, round_id, status, games, updated_at)
       VALUES (?, 'RndLV001', 'imported', 3, ?), (?, 'RndNX001', 'error', 0, ?), (?, 'RndDN002', 'partial', 2, ?)`,
      [dbId, now, dbId, now, dbId, now],
    );
    expect(labels(await tick(now + 2000))).toEqual(['Broadcast round RndLV002']);
    expect(paths()).toEqual(['/api/broadcast/top?page=1', '/api/broadcast/top?page=2', '/api/broadcast/TourLIVE']);

    // A day later every tour is checked again: the failed round is retried, the partial one redone,
    // the imported one left alone. RndDN001 ended more than a week ago: left to the monthly dumps.
    t.db.run("UPDATE jobs SET status = 'done'");
    calls.length = 0;
    expect(labels(await tick(now + 25 * 3600_000))).toEqual(['Broadcast round RndNX001', 'Broadcast round RndLV002', 'Broadcast round RndDN002']);
    expect(paths().filter(p => !p.startsWith('/api/broadcast/top'))).toEqual([
      '/api/broadcast/TourNEXT',
      '/api/broadcast/TourLIVE',
      '/api/broadcast/TourDONE',
    ]);
  });

  it('remembers tours that are gone, and stops at the first upstream failure', async () => {
    t.db.run("UPDATE jobs SET status = 'done'");
    const top = JSON.parse(TOP);
    top.active[0].round = { ...top.active[0].round, ongoing: true };
    overrides['/api/broadcast/top?page=1'] = () => json(JSON.stringify(top));
    overrides['/api/broadcast/TourNEXT'] = () => new Response('{"error":"Not found"}', { status: 404 });
    expect(await tick(now + 26 * 3600_000)).toEqual([]);
    calls.length = 0;
    await tick(now + 26 * 3600_000 + 60_000);
    expect(paths()).not.toContain('/api/broadcast/TourNEXT');

    overrides['/api/broadcast/top?page=1'] = () => new Response('slow down', { status: 429, headers: { 'retry-after': '60' } });
    await expect(tick(now + 27 * 3600_000)).rejects.toMatchObject({ reason: 'rate_limited' });
  });

  it('skips without a token, and the timer only runs when started', async () => {
    const noToken = await makeTestApp({ fetch: lichessFake(calls) });
    try {
      writeSettings(noToken.db, { broadcastAutoImport: true });
      calls.length = 0;
      expect(await autoImportFinishedRounds({ db: noToken.db, config: noToken.config, upstream: noToken.app.upstream })).toEqual([]);
      expect(calls).toEqual([]);
      expect(noToken.config.startWorkers).toBe(false);
    } finally {
      await noToken.close();
    }
    const fresh = await makeTestApp({ fetch: lichessFake(calls), env: { LICHESS_TOKEN: 'lip_testtoken' } });
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
    try {
      writeSettings(fresh.db, { broadcastAutoImport: true });
      calls.length = 0;
      const stop = startBroadcastAutoImport({ db: fresh.db, config: fresh.config, upstream: fresh.app.upstream });
      await vi.advanceTimersByTimeAsync(61_000);
      await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));
      expect(calls[0]!.url).toBe('https://lichess.org/api/broadcast/top?page=1');
      await stop();
      const n = calls.length;
      await vi.advanceTimersByTimeAsync(3600_000);
      expect(calls).toHaveLength(n);
    } finally {
      vi.useRealTimers();
      await fresh.close();
    }
  });
});
