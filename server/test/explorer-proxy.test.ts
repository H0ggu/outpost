import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { openDb } from '../src/db/index.ts';
import { migrate } from '../src/db/migrate.ts';
import { createExplorerProxy } from '../src/explorer/proxy.ts';
import { HttpError } from '../src/http/errors.ts';
import { createUpstream } from '../src/http/upstream.ts';
import { writeSettings } from '../src/settings.ts';
import { expectSameShape, fixtureText } from './explorer-support.ts';
import { createUserSession, makeTestApp, type TestApp } from './helpers.ts';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const HOUR = 3_600_000;

interface Call {
  url: URL;
  headers: Headers;
}
type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

/** A fake upstream: records calls and answers with the current handler. */
function fakeUpstream() {
  const calls: Call[] = [];
  let handler: Handler = () => new Response('no handler', { status: 500 });
  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push({ url, headers: new Headers(init.headers) });
    return handler(url, init);
  };
  return {
    fetch,
    calls,
    on(h: Handler) {
      handler = h;
    },
    reset() {
      calls.length = 0;
    },
  };
}

/** A Response that waits for `ms` (or rejects when the request is aborted). */
const delayed = (ms: number, res: () => Response, signal?: AbortSignal | null): Promise<Response> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(res()), ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(signal.reason ?? new Error('aborted'));
    });
  });

const mastersSample = fixtureText('masters-sample.json').trim();

describe('explorer proxies', () => {
  const up = fakeUpstream();
  let t: TestApp;
  let user: string;

  beforeAll(async () => {
    t = await makeTestApp({ fetch: up.fetch });
    user = createUserSession(t.db, { username: 'uma' }).cookie;
  });
  afterAll(async () => {
    await t?.close();
  });
  afterEach(() => {
    up.reset();
    writeSettings(t.db, { lichessToken: null });
  });

  const get = (url: string, cookie: string | null = user) => t.app.inject({ url, headers: cookie ? { cookie } : {} });
  const ageCache = (prefix: string, ms: number) =>
    t.db.run('UPDATE http_cache SET fetched_at = fetched_at - ? WHERE key LIKE ?', [ms, `${prefix}%`]);

  describe('masters', () => {
    it('proxies explorer.lichess.org/masters anonymously, with a normalised query, cached 3 h', async () => {
      writeSettings(t.db, { lichessToken: 'lip_secret' });
      up.on(() => new Response(mastersSample, { headers: { 'content-type': 'application/json', etag: '"m1"' } }));
      const q = `variant=standard&fen=${encodeURIComponent(START)}&play=e2e4,c7c5,g1f3&since=1952&until=2026&source=analysis&topGames=4&moves=4&recentGames=0`;
      const res = await get(`/api/explorer/masters?${q}`);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
      expect(res.headers['x-outpost-cache']).toBe('miss');
      expect(res.headers['x-outpost-source']).toBe('lichess');
      expect(res.body).toBe(mastersSample);
      expectSameShape(JSON.parse(res.body), JSON.parse(mastersSample), { nullable: ['winner', 'game', 'opening'] });
      expect(up.calls).toHaveLength(1);
      const call = up.calls[0]!;
      expect(`${call.url.origin}${call.url.pathname}`).toBe('https://explorer.lichess.org/masters');
      expect([...call.url.searchParams.keys()]).toEqual(['fen', 'moves', 'play', 'since', 'topGames', 'until']);
      expect(call.url.searchParams.get('fen')).toBe(START);
      expect(call.url.searchParams.get('play')).toBe('e2e4,c7c5,g1f3');
      expect(call.headers.get('authorization')).toBeNull();
      expect(call.headers.get('user-agent')).toMatch(/^Outpost\//);

      // Same request, other parameter order, other ignored extras: served from the cache.
      const again = await get(`/api/explorer/masters?moves=4&topGames=4&play=e2e4,c7c5,g1f3&until=2026&since=1952&fen=${encodeURIComponent(START.replace(/ /g, '_'))}&source=x`);
      expect(again.headers['x-outpost-cache']).toBe('hit');
      expect(again.body).toBe(mastersSample);
      expect(up.calls).toHaveLength(1);

      // After 3 h it revalidates with the ETag.
      ageCache('ex:masters:', 3 * HOUR + 1);
      up.on((_u, init) => {
        expect(new Headers(init.headers).get('if-none-match')).toBe('"m1"');
        return new Response(null, { status: 304 });
      });
      const revalidated = await get(`/api/explorer/masters?${q}`);
      expect(revalidated.headers['x-outpost-cache']).toBe('revalidated');
      expect(revalidated.body).toBe(mastersSample);
      expect(up.calls).toHaveLength(2);
      expect((await get(`/api/explorer/masters?${q}`)).headers['x-outpost-cache']).toBe('hit');
    });

    it('serves a stale answer when Lichess fails, and errors once it has expired', async () => {
      up.on(() => new Response(mastersSample));
      expect((await get('/api/explorer/masters?play=d2d4')).statusCode).toBe(200);
      ageCache('ex:masters:', 4 * HOUR);
      up.on(() => new Response('down', { status: 502 }));
      const stale = await get('/api/explorer/masters?play=d2d4');
      expect(stale.statusCode).toBe(200);
      expect(stale.headers['x-outpost-cache']).toBe('stale');
      ageCache('ex:masters:', 30 * 24 * HOUR);
      const gone = await get('/api/explorer/masters?play=d2d4');
      expect(gone.statusCode).toBe(502);
      expect(gone.json().error.code).toBe('upstream_error');
    });

    it('retries with the token after a 401, then uses it first; 503 no_token without one', async () => {
      up.on((_u, init) =>
        new Headers(init.headers).get('authorization') ? new Response(mastersSample) : new Response('unauthorized', { status: 401 }),
      );
      writeSettings(t.db, { lichessToken: 'lip_secret' });
      const withToken = await get('/api/explorer/masters?play=c2c4');
      expect(withToken.statusCode).toBe(200);
      expect(up.calls.map(c => c.headers.get('authorization'))).toEqual([null, 'Bearer lip_secret']);
      // Lichess refused anonymous requests: the next ones use the token straight away.
      up.reset();
      expect((await get('/api/explorer/masters?play=b2b3')).statusCode).toBe(200);
      expect(up.calls.map(c => c.headers.get('authorization'))).toEqual(['Bearer lip_secret']);
      // Without a token: a clean 503 with the reason.
      writeSettings(t.db, { lichessToken: null });
      const noToken = await get('/api/explorer/masters?play=a2a3');
      expect(noToken.statusCode).toBe(503);
      expect(noToken.json().error).toMatchObject({ code: 'upstream_unavailable', details: { reason: 'no_token' } });
    });

    it('makes one upstream call for concurrent identical requests', async () => {
      up.on((_u, init) => delayed(40, () => new Response(mastersSample), init.signal));
      const all = await Promise.all([1, 2, 3].map(() => get('/api/explorer/masters?play=g1f3')));
      expect(all.map(r => r.statusCode)).toEqual([200, 200, 200]);
      expect(up.calls).toHaveLength(1);
    });

    it('rejects bad input without calling Lichess', async () => {
      for (const q of ['play=e2e5', 'fen=garbage', 'since=19', 'topGames=99', 'moves=-1']) {
        const res = await get(`/api/explorer/masters?${q}`);
        expect(res.statusCode, q).toBe(400);
      }
      expect(up.calls).toHaveLength(0);
      expect((await get('/api/explorer/masters', null)).statusCode).toBe(401);
    });

    it('passes Lichess 400s through as bad_request', async () => {
      up.on(() => new Response('bad request: whatever', { status: 400 }));
      const res = await get('/api/explorer/masters?play=b1c3');
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toContain('bad request: whatever');
    });

    it('proxies masters PGNs (404 passthrough, cached)', async () => {
      const pgn = '[Event "Synthetic"]\n[White "A"]\n[Black "B"]\n[Result "1-0"]\n\n1. e4 1-0\n';
      up.on(url => (url.pathname.endsWith('/AbCdEfGh') ? new Response(pgn, { headers: { 'content-type': 'application/x-chess-pgn' } }) : new Response('', { status: 404 })));
      const ok = await get('/api/explorer/masters/pgn/AbCdEfGh');
      expect(ok.statusCode).toBe(200);
      expect(ok.headers['content-type']).toBe('application/x-chess-pgn; charset=utf-8');
      expect(ok.body).toBe(pgn);
      expect(up.calls[0]!.url.href).toBe('https://explorer.lichess.org/masters/pgn/AbCdEfGh');
      const missing = await get('/api/explorer/masters/pgn/ZZZZZZZZ');
      expect(missing.statusCode).toBe(404);
      expect(missing.json().error.code).toBe('not_found');
      expect((await get('/api/explorer/masters/pgn/ZZZZZZZZ')).headers['x-outpost-cache']).toBe('hit');
      expect(up.calls).toHaveLength(2);
    });
  });

  describe('lichess', () => {
    it('answers 503 no_token without a token, without calling Lichess', async () => {
      const res = await get('/api/explorer/lichess?variant=standard&play=e2e4');
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toMatchObject({ code: 'upstream_unavailable', details: { reason: 'no_token' } });
      expect(res.json().error.message).toMatch(/LICHESS_TOKEN/);
      expect(up.calls).toHaveLength(0);
    });

    it('needs a signed-in user (it spends the instance token)', async () => {
      writeSettings(t.db, { anonymousBrowsing: true });
      try {
        expect((await get('/api/explorer/lichess?play=e2e4', null)).statusCode).toBe(401);
      } finally {
        writeSettings(t.db, { anonymousBrowsing: false });
      }
    });

    it('sends the token, normalises the query and caches', async () => {
      writeSettings(t.db, { lichessToken: 'lip_secret' });
      const body = JSON.stringify({ ...JSON.parse(mastersSample), recentGames: [] });
      up.on(() => new Response(body));
      const q = `variant=standard&fen=${encodeURIComponent(START)}&play=e2e4&speeds=rapid,blitz,blitz&ratings=2200,1800&source=analysis&topGames=0&recentGames=0`;
      const res = await get(`/api/explorer/lichess?${q}`);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.body).toBe(body);
      const call = up.calls[0]!;
      expect(call.url.origin + call.url.pathname).toBe('https://explorer.lichess.org/lichess');
      expect(call.headers.get('authorization')).toBe('Bearer lip_secret');
      expect(call.url.searchParams.get('speeds')).toBe('blitz,rapid');
      expect(call.url.searchParams.get('ratings')).toBe('1800,2200');
      expect(call.url.searchParams.get('variant')).toBe('standard');
      expect(call.url.searchParams.has('source')).toBe(false);
      expect((await get(`/api/explorer/lichess?${q}`)).headers['x-outpost-cache']).toBe('hit');
      expect(up.calls).toHaveLength(1);
      // Also under a filtered base (lila resolves './lichess' against it); the filters don't apply.
      expect((await get(`/api/explorer/f/_/lichess?${q}`)).headers['x-outpost-cache']).toBe('hit');
    });

    it('reports a rejected token and a Lichess rate limit as 503s', async () => {
      writeSettings(t.db, { lichessToken: 'lip_secret' });
      up.on(() => new Response('', { status: 401 }));
      const rejected = await get('/api/explorer/lichess?play=d2d4');
      expect(rejected.statusCode).toBe(503);
      expect(rejected.json().error.details.reason).toBe('token_rejected');

      up.on(() => new Response('', { status: 429, headers: { 'retry-after': '120' } }));
      const limited = await get('/api/explorer/lichess?play=c2c4');
      expect(limited.statusCode).toBe(503);
      expect(limited.json().error.details).toMatchObject({ reason: 'rate_limited' });
      expect(limited.json().error.details.retryAt).toBeGreaterThan(Date.now() + 100_000);
      // explorer.lichess.org cools down for every module: no new upstream call.
      const calls = up.calls.length;
      expect((await get('/api/explorer/lichess?play=g1f3')).statusCode).toBe(503);
      expect(up.calls).toHaveLength(calls);
    });

    it('validates variants, speeds and lines', async () => {
      writeSettings(t.db, { lichessToken: 'lip_secret' });
      for (const q of ['variant=chess961', 'speeds=hyper', 'ratings=abc', 'play=e2e5', 'topGames=9', 'history=maybe']) {
        expect((await get(`/api/explorer/lichess?${q}`)).statusCode, q).toBe(400);
      }
      expect(up.calls).toHaveLength(0);
    });
  });

  describe('tablebase', () => {
    it('needs no session, sends no token, normalises the FEN and caches', async () => {
      writeSettings(t.db, { lichessToken: 'lip_secret' });
      const body = fixtureText('tablebase-sample.json').trim();
      up.on(() => new Response(body, { headers: { 'content-type': 'application/json' } }));
      const res = await get('/api/tablebase/standard?fen=4k3/6KP/8/8/8/8/7p/8_w_-_-_0_1', null);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.body).toBe(body);
      expect(JSON.parse(res.body)).toMatchObject({ category: 'win', moves: expect.any(Array) });
      const call = up.calls[0]!;
      expect(call.url.origin + call.url.pathname).toBe('https://tablebase.lichess.ovh/standard');
      expect(call.url.searchParams.get('fen')).toBe('4k3/6KP/8/8/8/8/7p/8 w - - 0 1');
      expect(call.headers.get('authorization')).toBeNull();
      const again = await get(`/api/tablebase/standard?fen=${encodeURIComponent('4k3/6KP/8/8/8/8/7p/8 w - - 0 1')}`, null);
      expect(again.headers['x-outpost-cache']).toBe('hit');
      expect(up.calls).toHaveLength(1);
    });

    it('validates the variant and the position', async () => {
      expect((await get('/api/tablebase/crazyhouse?fen=4k3/8/8/8/8/8/8/4K3_w_-_-_0_1', null)).statusCode).toBe(400);
      expect((await get(`/api/tablebase/standard?fen=${encodeURIComponent(START)}`, null)).statusCode).toBe(400);
      expect((await get('/api/tablebase/standard', null)).statusCode).toBe(400);
      expect((await get('/api/tablebase/standard?fen=xyz', null)).statusCode).toBe(400);
      expect(up.calls).toHaveLength(0);
    });
  });

  describe('cloud-eval', () => {
    it('passes evaluations through and caches them', async () => {
      const body = fixtureText('cloud-eval-sample.json').trim();
      up.on(() => new Response(body));
      const fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
      const res = await get(`/api/cloud-eval?fen=${encodeURIComponent(fen)}&multiPv=2`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ fen, depth: expect.any(Number), pvs: expect.any(Array) });
      const call = up.calls[0]!;
      expect(call.url.origin + call.url.pathname).toBe('https://lichess.org/api/cloud-eval');
      expect(call.url.searchParams.get('multiPv')).toBe('2');
      expect(call.headers.get('authorization')).toBeNull();
      expect((await get(`/api/cloud-eval?fen=${encodeURIComponent(fen)}&multiPv=2`)).headers['x-outpost-cache']).toBe('hit');
      expect(up.calls).toHaveLength(1);
    });

    it('passes 404s through (cached briefly) and validates', async () => {
      up.on(() => Response.json({ error: 'No cloud evaluation available for that position' }, { status: 404 }));
      const fen = '8/8/8/3k4/8/8/2NBK3/7q w - - 0 1';
      const res = await get(`/api/cloud-eval?fen=${encodeURIComponent(fen)}`);
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toEqual({ code: 'not_found', message: 'No cloud evaluation available for that position' });
      expect(up.calls[0]!.url.searchParams.get('multiPv')).toBe('1');
      expect((await get(`/api/cloud-eval?fen=${encodeURIComponent(fen)}`)).statusCode).toBe(404);
      expect(up.calls).toHaveLength(1);
      ageCache('ex:cloud-eval:', 11 * 60_000);
      await get(`/api/cloud-eval?fen=${encodeURIComponent(fen)}`);
      expect(up.calls).toHaveLength(2);
      expect((await get('/api/cloud-eval')).statusCode).toBe(400);
      expect((await get(`/api/cloud-eval?fen=${encodeURIComponent(fen)}&multiPv=9`)).statusCode).toBe(400);
      expect((await get(`/api/cloud-eval?fen=${encodeURIComponent(fen)}`, null)).statusCode).toBe(401);
    });
  });

  it('rate-limits the tablebase per IP', async () => {
    up.on(() => new Response('{"category":"draw","moves":[]}'));
    const statuses: number[] = [];
    for (let i = 0; i < 125; i++) statuses.push((await get('/api/tablebase/standard?fen=4k3/8/8/8/8/8/8/4K3_w_-_-_0_1', null)).statusCode);
    expect(statuses.filter(s => s === 200).length).toBeLessThanOrEqual(120);
    expect(statuses.at(-1)).toBe(429);
  });
});

describe('explorer proxy budgets and timeouts', () => {
  const setup = (opts: { perWindow?: number; windowMs?: number; maxQueue?: number; maxWaitMs?: number; headersMs?: number } = {}) => {
    const db = openDb(':memory:');
    migrate(db);
    const config = loadConfig({ NODE_ENV: 'test', LICHESS_TOKEN: 'lip_test' });
    const up = fakeUpstream();
    up.on(() => new Response('{"white":0,"draws":0,"black":0,"moves":[],"topGames":[],"recentGames":[]}'));
    const budget = { perWindow: opts.perWindow ?? 2, windowMs: opts.windowMs ?? 200, maxQueue: opts.maxQueue ?? 5, maxWaitMs: opts.maxWaitMs ?? 2000 };
    const proxy = createExplorerProxy({
      db,
      config,
      upstream: createUpstream({ config, db, fetch: up.fetch }),
      budgets: { lichess: budget, masters: budget },
      timeouts: { headersMs: opts.headersMs ?? 1000, bodyMs: 2000 },
    });
    const q = (play: string) => new URLSearchParams({ play, variant: 'standard' });
    return { db, up, proxy, q };
  };

  it('allows N requests per window and queues the rest FIFO', async () => {
    const { up, proxy, q } = setup({ perWindow: 2, windowMs: 200 });
    const started = Date.now();
    const done: string[] = [];
    await Promise.all(
      ['e2e4', 'd2d4', 'c2c4', 'g1f3'].map(m =>
        proxy.lichess(q(m)).then(() => {
          done.push(`${m}@${Date.now() - started >= 150 ? 'late' : 'now'}`);
        }),
      ),
    );
    expect(done).toEqual(['e2e4@now', 'd2d4@now', 'c2c4@late', 'g1f3@late']);
    expect(up.calls.map(c => c.url.searchParams.get('play'))).toEqual(['e2e4', 'd2d4', 'c2c4', 'g1f3']);
  });

  it('answers 503 when the queue is full or the wait is too long', async () => {
    const full = setup({ perWindow: 1, windowMs: 1000, maxQueue: 1 });
    const results = await Promise.allSettled(['e2e4', 'd2d4', 'c2c4'].map(m => full.proxy.lichess(full.q(m))));
    expect(results.map(r => r.status)).toEqual(['fulfilled', 'fulfilled', 'rejected']);
    const err = (results[2] as PromiseRejectedResult).reason as HttpError;
    expect(err).toBeInstanceOf(HttpError);
    expect(err.statusCode).toBe(503);
    expect(err.details).toMatchObject({ reason: 'queue_full' });

    const slow = setup({ perWindow: 1, windowMs: 5000, maxWaitMs: 50 });
    await slow.proxy.lichess(slow.q('e2e4'));
    const timedOut = await slow.proxy.lichess(slow.q('d2d4')).catch(e => e);
    expect(timedOut.details).toMatchObject({ reason: 'queue_timeout' });
    expect(slow.up.calls).toHaveLength(1);
  });

  it('drops a waiting request when its client goes away', async () => {
    const { up, proxy, q } = setup({ perWindow: 1, windowMs: 300 });
    await proxy.lichess(q('e2e4'));
    const ac = new AbortController();
    const pending = proxy.lichess(q('d2d4'), ac.signal).catch(e => e);
    const next = proxy.lichess(q('c2c4'));
    expect(proxy.budget('lichess').queued).toBe(2);
    ac.abort();
    await pending;
    expect(proxy.budget('lichess').queued).toBe(1);
    await next;
    expect(up.calls.map(c => c.url.searchParams.get('play'))).toEqual(['e2e4', 'c2c4']);
  });

  it('keeps a shared request alive while one of its clients still waits', async () => {
    const { up, proxy, q } = setup({ perWindow: 1, windowMs: 200 });
    await proxy.lichess(q('e2e4'));
    const ac = new AbortController();
    const a = proxy.lichess(q('d2d4'), ac.signal).catch(e => e);
    const b = proxy.lichess(q('d2d4'));
    ac.abort();
    await a;
    await expect(b).resolves.toMatchObject({ status: 200 });
    expect(up.calls).toHaveLength(2);
  });

  it('times out a silent upstream (503 timeout)', async () => {
    const { up, proxy, q } = setup({ headersMs: 50 });
    up.on((_u, init) => delayed(5000, () => new Response('{}'), init.signal));
    const err = await proxy.lichess(q('e2e4')).catch(e => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.statusCode).toBe(503);
    expect(err.details).toMatchObject({ reason: 'timeout' });
  });

  it('refuses oversized or invalid upstream bodies', async () => {
    const { up, proxy, q } = setup();
    up.on(() => new Response('not json'));
    expect((await proxy.lichess(q('e2e4')).catch(e => e)).statusCode).toBe(502);
    up.on(() => new Response('x', { headers: { 'content-length': String(10 * 1024 * 1024) } }));
    expect((await proxy.lichess(q('d2d4')).catch(e => e)).statusCode).toBe(502);
  });
});
