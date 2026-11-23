import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { openDb } from '../src/db/index.ts';
import { migrate } from '../src/db/migrate.ts';
import { createNnueStore } from '../src/explorer/nnue.ts';
import { createUpstream } from '../src/http/upstream.ts';
import { writeSettings } from '../src/settings.ts';
import { createUserSession, makeTestApp, type TestApp } from './helpers.ts';

/** A synthetic network whose name matches its SHA-256, like Stockfish's. */
const network = (size = 64 * 1024) => {
  const bytes = randomBytes(size);
  const name = `nn-${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}.nnue`;
  return { bytes, name };
};

describe('GET /assets/lifat/nnue/:name', () => {
  const good = network();
  const other = network(1024);
  const wrong = { bytes: randomBytes(2048), name: 'nn-0123456789ab.nnue' };
  const calls: string[] = [];
  let delayMs = 0;
  let t: TestApp;
  let user: string;

  beforeAll(async () => {
    t = await makeTestApp({
      fetch: async input => {
        const url = new URL(String(input instanceof Request ? input.url : input));
        calls.push(url.href);
        if (delayMs) await new Promise(r => setTimeout(r, delayMs));
        const name = url.pathname.split('/').pop();
        const file = [good, other, wrong].find(n => n.name === name);
        if (!file) return new Response('not found', { status: 404 });
        // Stream it in chunks, like a real download.
        const chunks = [file.bytes.subarray(0, 1000), file.bytes.subarray(1000)];
        return new Response(
          new ReadableStream({
            pull(c) {
              const next = chunks.shift();
              if (next) c.enqueue(new Uint8Array(next));
              else c.close();
            },
          }),
          { headers: { 'content-type': 'application/octet-stream', 'content-length': String(file.bytes.length) } },
        );
      },
    });
    user = createUserSession(t.db, { username: 'uma' }).cookie;
  });
  afterAll(async () => {
    await t?.close();
  });
  afterEach(() => {
    calls.length = 0;
    delayMs = 0;
  });

  const get = (name: string, opts: { cookie?: string | null; headers?: Record<string, string>; method?: 'GET' | 'HEAD' } = {}) =>
    t.app.inject({
      method: opts.method ?? 'GET',
      url: `/assets/lifat/nnue/${name}`,
      headers: { ...(opts.cookie === null ? {} : { cookie: opts.cookie ?? user }), ...opts.headers },
    });

  it('downloads once from tests.stockfishchess.org, verifies, stores and serves with immutable caching', async () => {
    const res = await get(good.name);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.rawPayload.equals(good.bytes)).toBe(true);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(res.headers['content-length']).toBe(String(good.bytes.length));
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['etag']).toBe(`"${good.name}"`);
    expect(res.headers['cross-origin-embedder-policy']).toBe('require-corp');
    expect(calls).toEqual([`https://tests.stockfishchess.org/api/nn/${good.name}`]);
    // Stored under its name in DATA_DIR/nnue, no temp files left behind.
    expect(readFileSync(join(t.config.nnueDir, good.name)).equals(good.bytes)).toBe(true);
    expect(readdirSync(t.config.nnueDir)).toEqual([good.name]);

    // Next time from disk — anonymous visitors too (public, immutable data).
    const cached = await get(good.name, { cookie: null });
    expect(cached.statusCode).toBe(200);
    expect(cached.rawPayload.equals(good.bytes)).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('shares one download between concurrent requests', async () => {
    delayMs = 30;
    const all = await Promise.all([1, 2, 3, 4].map(() => get(other.name)));
    expect(all.map(r => r.statusCode)).toEqual([200, 200, 200, 200]);
    expect(all.every(r => r.rawPayload.equals(other.bytes))).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('rejects a file whose SHA-256 does not match its name, keeping nothing', async () => {
    const res = await get(wrong.name);
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatchObject({ code: 'upstream_error', details: { reason: 'hash_mismatch' } });
    expect(existsSync(join(t.config.nnueDir, wrong.name))).toBe(false);
    expect(readdirSync(t.config.nnueDir).filter(f => f.startsWith('.'))).toEqual([]);
    // The failure is remembered for a while: no new download attempt.
    expect((await get(wrong.name)).statusCode).toBe(502);
    expect(calls).toHaveLength(1);
  });

  it('answers 404 for unknown networks (remembered) and for names outside the allow-list (no upstream call)', async () => {
    const missing = 'nn-ffffffffffff.nnue';
    expect((await get(missing)).statusCode).toBe(404);
    expect((await get(missing)).statusCode).toBe(404);
    expect(calls).toHaveLength(1);
    calls.length = 0;
    for (const bad of ['nn-FFFFFFFFFFFF.nnue', 'nn-123.nnue', 'x.nnue', '..%2Fsecret', 'nn-ffffffffffff.nnue.tmp', 'nn-ffffffffffff.bin']) {
      const res = await get(bad);
      expect(res.statusCode, bad).toBe(404);
    }
    expect(calls).toHaveLength(0);
  });

  it('needs a viewer to start a download', async () => {
    const fresh = network(512);
    expect((await get(fresh.name, { cookie: null })).statusCode).toBe(401);
    expect(calls).toHaveLength(0);
    writeSettings(t.db, { anonymousBrowsing: true });
    try {
      // Unknown upstream (404) but the download was attempted.
      expect((await get(fresh.name, { cookie: null })).statusCode).toBe(404);
      expect(calls).toHaveLength(1);
    } finally {
      writeSettings(t.db, { anonymousBrowsing: false });
    }
  });

  it('supports Range, If-None-Match and HEAD', async () => {
    await get(good.name);
    const part = await get(good.name, { headers: { range: 'bytes=10-19' } });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 10-19/${good.bytes.length}`);
    expect(part.headers['content-length']).toBe('10');
    expect(part.rawPayload.equals(good.bytes.subarray(10, 20))).toBe(true);
    const tail = await get(good.name, { headers: { range: 'bytes=-5' } });
    expect(tail.rawPayload.equals(good.bytes.subarray(good.bytes.length - 5))).toBe(true);
    const bad = await get(good.name, { headers: { range: `bytes=${good.bytes.length}-` } });
    expect(bad.statusCode).toBe(416);
    expect(bad.headers['content-range']).toBe(`bytes */${good.bytes.length}`);
    const notModified = await get(good.name, { headers: { 'if-none-match': `"${good.name}"` } });
    expect(notModified.statusCode).toBe(304);
    expect(notModified.rawPayload.length).toBe(0);
    const head = await get(good.name, { method: 'HEAD' });
    expect(head.statusCode).toBe(200);
    expect(head.headers['content-length']).toBe(String(good.bytes.length));
    expect(head.rawPayload.length).toBe(0);
  });
});

describe('NNUE store limits', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  const setup = (fetch: typeof globalThis.fetch, opts: { maxBytes?: number; maxFiles?: number } = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'outpost-nnue-'));
    dirs.push(dir);
    const db = openDb(':memory:');
    migrate(db);
    const config = loadConfig({ NODE_ENV: 'test' });
    const store = createNnueStore({ dir, upstream: createUpstream({ config, db, fetch }), ...opts });
    return { dir, store };
  };

  it('refuses networks over the size limit, declared or streamed', async () => {
    const net = network(4096);
    const declared = setup(async () => new Response(net.bytes, { headers: { 'content-length': '4096' } }), { maxBytes: 1000 });
    await expect(declared.store.ensure(net.name)).rejects.toMatchObject({ reason: 'too_large' });
    const streamed = setup(async () => new Response(new Blob([net.bytes]).stream()), { maxBytes: 1000 });
    await expect(streamed.store.ensure(net.name)).rejects.toMatchObject({ reason: 'too_large' });
    expect(readdirSync(streamed.dir)).toEqual([]);
  });

  it('keeps at most maxFiles networks', async () => {
    const net = network(256);
    const { dir, store } = setup(async () => new Response(net.bytes), { maxFiles: 1 });
    writeFileSync(join(dir, 'nn-aaaaaaaaaaaa.nnue'), 'x');
    await expect(store.ensure(net.name)).rejects.toMatchObject({ reason: 'quota' });
  });

  it('maps network failures to an upstream error and retries after the failure window', async () => {
    const net = network(256);
    let fail = true;
    const { store } = setup(async () => {
      if (fail) throw new Error('ECONNRESET');
      return new Response(net.bytes);
    });
    await expect(store.ensure(net.name)).rejects.toMatchObject({ reason: 'upstream' });
    fail = false;
    // Still remembered as failed.
    await expect(store.ensure(net.name)).rejects.toMatchObject({ reason: 'upstream' });
    expect(store.inFlight()).toEqual([]);
  });
});
