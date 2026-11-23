import { afterEach, describe, expect, it } from 'vitest';
import { HttpError } from '../src/http/errors.ts';
import { createUpstream, parseRetryAfter, upstreamHttpError, UpstreamError, UPSTREAM } from '../src/http/upstream.ts';
import { loadConfig } from '../src/config.ts';
import { openDb } from '../src/db/index.ts';
import { migrate } from '../src/db/migrate.ts';
import { writeSettings } from '../src/settings.ts';
import { makeTestApp, type TestApp } from './helpers.ts';

interface Call {
  url: string;
  headers: Headers;
}

const setup = (opts: { env?: Record<string, string>; respond?: (url: URL, init: RequestInit) => Response | Promise<Response> } = {}) => {
  const db = openDb(':memory:');
  migrate(db);
  const config = loadConfig({ NODE_ENV: 'test', ...opts.env });
  const calls: Call[] = [];
  let clock = Date.UTC(2026, 10, 1);
  const upstream = createUpstream({
    config,
    db,
    now: () => clock,
    fetch: async (input, init = {}) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      calls.push({ url: url.toString(), headers: new Headers(init.headers) });
      return opts.respond ? opts.respond(url, init) : Response.json({ ok: true });
    },
  });
  return { db, config, upstream, calls, advance: (ms: number) => (clock += ms) };
};

describe('upstream client', () => {
  it('sends the Outpost User-Agent with the configured contact', async () => {
    const { db, upstream, calls } = setup();
    await upstream.json(`${UPSTREAM.chesscom}/pub/player/hikaru`);
    expect(calls[0]!.headers.get('user-agent')).toMatch(/^Outpost\/\S+ \(self-hosted\)$/);
    writeSettings(db, { chesscomContact: 'admin@example.com' });
    await upstream.json(`${UPSTREAM.chesscom}/pub/player/hikaru`);
    expect(calls[1]!.headers.get('user-agent')).toContain('contact: admin@example.com');
    expect(calls[1]!.headers.get('accept')).toBe('application/json');
  });

  it('adds the Lichess token only when asked, and only for Lichess hosts', async () => {
    const { upstream, calls } = setup({ env: { LICHESS_TOKEN: 'lip_secret' } });
    await upstream.fetch(`${UPSTREAM.lichess}/api/user/someone`);
    expect(calls[0]!.headers.get('authorization')).toBeNull();
    await upstream.fetch(`${UPSTREAM.lichess}/api/user/someone`, { auth: 'optional', headers: { authorization: 'x' } });
    expect(calls[1]!.headers.get('authorization')).toBe('Bearer lip_secret');
    await upstream.fetch(`${UPSTREAM.explorer}/lichess?fen=x`, { auth: 'required' });
    expect(calls[2]!.headers.get('authorization')).toBe('Bearer lip_secret');
    await expect(upstream.fetch(`${UPSTREAM.chesscom}/pub/player/x`, { auth: 'optional' })).rejects.toThrow(/Refusing/);
    await upstream.fetch(`${UPSTREAM.chesscom}/pub/player/x`, { headers: { Authorization: 'Bearer leak' } });
    expect(calls.at(-1)!.headers.get('authorization')).toBeNull();
  });

  it('fails with no_token (→ 503) when a token is required but missing', async () => {
    const { upstream, calls } = setup();
    const err = await upstream.fetch(`${UPSTREAM.lichess}/api/broadcast`, { auth: 'required' }).catch(e => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err.reason).toBe('no_token');
    expect(calls).toHaveLength(0);
    const http = upstreamHttpError(err) as HttpError;
    expect(http.statusCode).toBe(503);
    expect(http.code).toBe('upstream_unavailable');
  });

  it('puts a host in a shared cool-down after a 429', async () => {
    let status = 429;
    const { upstream, calls, advance } = setup({
      respond: () => new Response('slow down', { status, headers: { 'retry-after': '5' } }),
    });
    const first = await upstream.fetch(`${UPSTREAM.lichess}/api/games/user/a`).catch(e => e);
    expect(first).toMatchObject({ reason: 'rate_limited', status: 429, host: 'lichess.org' });
    // Retry-After 5 s is raised to the 60 s minimum.
    expect(first.retryAt - Date.UTC(2026, 10, 1)).toBe(60_000);

    status = 200;
    const second = await upstream.fetch(`${UPSTREAM.lichess}/api/user/b`).catch(e => e);
    expect(second.reason).toBe('rate_limited');
    expect(calls).toHaveLength(1); // failed fast, no request
    await upstream.fetch(`${UPSTREAM.chesscom}/pub/player/x`); // other hosts unaffected
    expect(upstream.cooldownUntil('lichess.org')).not.toBeNull();

    advance(60_000);
    expect(upstream.cooldownUntil('lichess.org')).toBeNull();
    const ok = await upstream.fetch(`${UPSTREAM.lichess}/api/user/b`);
    expect(ok.status).toBe(200);
  });

  it('throws on unexpected statuses unless allowed', async () => {
    const { upstream } = setup({ respond: () => new Response('nope', { status: 404 }) });
    const err = await upstream.fetch(`${UPSTREAM.lichess}/api/cloud-eval?fen=x`).catch(e => e);
    expect(err).toMatchObject({ reason: 'status', status: 404 });
    expect((upstreamHttpError(err) as HttpError).statusCode).toBe(502);
    const res = await upstream.fetch(`${UPSTREAM.lichess}/api/cloud-eval?fen=x`, { allowStatuses: [404] });
    expect(res.status).toBe(404);
  });

  it('times out when the headers take too long', async () => {
    const { upstream } = setup({
      respond: (_url, init) =>
        new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted')))),
    });
    const err = await upstream.fetch(`${UPSTREAM.tablebase}/standard?fen=x`, { timeoutMs: 20 }).catch(e => e);
    expect(err).toMatchObject({ reason: 'timeout' });
    const caller = new AbortController();
    const pending = upstream.fetch(`${UPSTREAM.tablebase}/standard?fen=x`, { signal: caller.signal }).catch(e => e);
    caller.abort();
    expect(await pending).toMatchObject({ reason: 'aborted' });
  });

  it('parses Retry-After', () => {
    expect(parseRetryAfter('120', 0)).toBe(120_000);
    expect(parseRetryAfter(new Date(90_000).toUTCString(), 30_000)).toBe(60_000);
    expect(parseRetryAfter(null, 0)).toBeNull();
    expect(parseRetryAfter('soon', 0)).toBeNull();
  });
});

describe('app.upstream in tests', () => {
  let t: TestApp;
  afterEach(async () => t.close());

  it('has no network by default', async () => {
    t = await makeTestApp();
    const err = await t.app.upstream.fetch(`${UPSTREAM.lichess}/api/user/x`).catch(e => e);
    expect(err).toMatchObject({ reason: 'network' });
    expect(t.config.startWorkers).toBe(false);
  });

  it('uses an injected fetch', async () => {
    t = await makeTestApp({ fetch: async () => Response.json({ id: 'x' }) });
    await expect(t.app.upstream.json(`${UPSTREAM.lichess}/api/user/x`)).resolves.toEqual({ id: 'x' });
  });
});
