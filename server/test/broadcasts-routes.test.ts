import { readFileSync } from 'node:fs';
import type { BroadcastRound, BroadcastsResponse, BroadcastTour } from '@outpost/shared/api';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { standardLastMove, toBroadcastsResponse } from '../src/broadcasts/index.ts';
import { TtlCache } from '../src/broadcasts/service.ts';
import { autoImportFinishedRounds, startBroadcastAutoImport } from '../src/reference/autoImport.ts';
import { ensureBroadcastDatabase } from '../src/reference/databases.ts';
import { referencePlayerByFideId } from '../src/reference/players.ts';
import { writeSettings } from '../src/settings.ts';
import { createUserSession, makeTestApp, type TestApp } from './helpers.ts';

const FIXTURES = new URL('./fixtures/reference/', import.meta.url);
const text = (name: string): string => readFileSync(new URL(name, FIXTURES), 'utf8');

const LIST = text('broadcast-list.ndjson');
const TOUR = text('broadcast-tour.json');
const ROUND = text('broadcast-round.json');
const ROUND_PGN = text('round-Rnd5EEEE.pgn');

interface Call {
  url: string;
  auth: string | null;
  accept: string | null;
}

function lichessFake(calls: Call[]): typeof globalThis.fetch {
  return async (input, init = {}) => {
    const url = new URL(String(input));
    const headers = new Headers(init.headers);
    calls.push({ url: url.href, auth: headers.get('authorization'), accept: headers.get('accept') });
    if (url.host !== 'lichess.org') throw new Error(`unexpected host ${url.host}`);
    const p = url.pathname;
    if (p === '/api/broadcast') return new Response(LIST, { headers: { 'content-type': 'application/x-ndjson' } });
    if (p === '/api/broadcast/TourLIVE') return new Response(TOUR, { headers: { 'content-type': 'application/json' } });
    if (p === '/api/broadcast/-/-/RndLV002') return new Response(ROUND, { headers: { 'content-type': 'application/json' } });
    if (p === '/api/broadcast/round/RndLV002.pgn') return new Response(ROUND_PGN, { headers: { 'content-type': 'application/x-chess-pgn' } });
    if (p === '/api/broadcast/-/-/BrokenJs') return new Response('{"oops":', { headers: { 'content-type': 'application/json' } });
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

  it('lists official broadcasts with the token: live first, finished ones as recent', async () => {
    const res = await get('/api/broadcasts');
    expect(res.statusCode).toBe(200);
    const body = res.json<BroadcastsResponse>();
    expect(body.active.map(b => [b.tour.id, b.live, b.defaultRoundId])).toEqual([
      ['TourLIVE', true, 'RndLV002'],
      ['TourUPCO', false, 'RndUP001'],
    ]);
    expect(body.recent.map(b => b.tour.id)).toEqual(['TourDONE']);
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
      { id: 'RndLV001', name: 'Round 1', slug: 'round-1', startsAt: 1795000000000, finished: true, ongoing: false, url: 'https://lichess.org/broadcast/live-test-open-masters/round-1/RndLV001' },
      { id: 'RndLV002', name: 'Round 2', slug: 'round-2', startsAt: 1795086400000, finished: false, ongoing: true, url: 'https://lichess.org/broadcast/live-test-open-masters/round-2/RndLV002' },
      { id: 'RndLV003', name: 'Round 3', slug: 'round-3', startsAt: 1795172800000, finished: false, ongoing: false, url: 'https://lichess.org/broadcast/live-test-open-masters/round-3/RndLV003' },
    ]);
    expect(calls).toEqual([{ url: 'https://lichess.org/api/broadcast?nb=80', auth: 'Bearer lip_testtoken', accept: 'application/x-ndjson' }]);
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

  it('answers clean errors: unknown rounds 404, bad ids 400, upstream failures 502', async () => {
    expect((await get('/api/broadcasts/round/Missing1')).statusCode).toBe(404);
    expect((await get('/api/broadcasts/round/Missing1.pgn')).statusCode).toBe(404);
    expect((await get('/api/broadcasts/round/not-an-id')).statusCode).toBe(400);
    expect((await get('/api/broadcasts/round/..%2F..%2Fx')).statusCode).toBe(400);
    const broken = await get('/api/broadcasts/round/BrokenJs');
    expect(broken.statusCode).toBe(502);
    expect(broken.json().error.code).toBe('upstream_error');
    const down = await get('/api/broadcasts/round/Teapot42');
    expect(down.statusCode).toBe(502);
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

  it('dedupes tours and drops broken entries', () => {
    const res = toBroadcastsResponse([
      { tour: { id: 'A', name: 'A', slug: 'a' }, rounds: [] },
      { tour: { id: 'A', name: 'A again', slug: 'a' }, rounds: [] },
    ]);
    expect(res.active.map(b => b.tour.name)).toEqual(['A']);
    expect(res.active[0]!.defaultRoundId).toBeNull();
  });

  it('TtlCache drops failures so the next call retries', async () => {
    let n = 0;
    const cache = new TtlCache<number>(1000);
    await expect(cache.get('k', async () => Promise.reject(new Error(`fail ${++n}`)))).rejects.toThrow('fail 1');
    expect(await cache.get('k', async () => ++n)).toBe(2);
    expect(await cache.get('k', async () => ++n)).toBe(2);
  });
});

describe('broadcast auto-import', () => {
  let t: TestApp;
  const calls: Call[] = [];
  const now = 1794500000000; // within a week of every finished round in the fixture

  beforeAll(async () => {
    t = await makeTestApp({ fetch: lichessFake(calls), env: { LICHESS_TOKEN: 'lip_testtoken' } });
  });
  afterAll(async () => {
    await t.close();
  });

  const tick = (at = now) => autoImportFinishedRounds({ db: t.db, config: t.config, upstream: t.app.upstream, now: at });

  it('does nothing unless the admin setting is on', async () => {
    expect(await tick()).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('queues finished rounds of the last week once, at background priority', async () => {
    writeSettings(t.db, { broadcastAutoImport: true });
    const jobs = await tick(now);
    expect(jobs.map(j => [j.kind, j.lane, j.priority, j.label])).toEqual([
      ['broadcastRound', 'lichess', -10, 'Broadcast round RndLV001'],
      ['broadcastRound', 'lichess', -10, 'Broadcast round RndDN001'],
      ['broadcastRound', 'lichess', -10, 'Broadcast round RndDN002'],
    ]);
    expect(calls.map(c => [c.url, c.auth])).toEqual([['https://lichess.org/api/broadcast?nb=60', 'Bearer lip_testtoken']]);
    const dbId = ensureBroadcastDatabase(t.db);
    expect(JSON.parse(t.db.value<string>('SELECT payload_json FROM jobs WHERE id = ?', [jobs[0]!.id])!)).toEqual({ databaseId: dbId, roundId: 'RndLV001' });
    // Already queued: not again.
    expect(await tick(now)).toEqual([]);
    // Imported rounds are skipped; failed ones wait a day.
    t.db.run("UPDATE jobs SET status = 'done'");
    t.db.run(
      `INSERT INTO reference_broadcast_rounds (database_id, round_id, status, games, updated_at)
       VALUES (?, 'RndLV001', 'imported', 3, ?), (?, 'RndDN001', 'error', 0, ?)`,
      [dbId, now, dbId, now],
    );
    expect((await tick(now + 3600_000)).map(j => j.label)).toEqual(['Broadcast round RndDN002']);
    t.db.run("UPDATE jobs SET status = 'done'");
    expect((await tick(now + 25 * 3600_000)).map(j => j.label)).toEqual(['Broadcast round RndDN001', 'Broadcast round RndDN002']);
    // Rounds older than a week are left to the monthly dumps.
    t.db.run("UPDATE jobs SET status = 'done'");
    expect(await tick(now + 30 * 86400_000)).toEqual([]);
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
    vi.useFakeTimers();
    try {
      calls.length = 0;
      const stop = startBroadcastAutoImport({ db: t.db, config: t.config, upstream: t.app.upstream });
      await vi.advanceTimersByTimeAsync(61_000);
      expect(calls.map(c => c.url)).toEqual(['https://lichess.org/api/broadcast?nb=60']);
      stop();
      await vi.advanceTimersByTimeAsync(3600_000);
      expect(calls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
