import { afterEach, describe, expect, it } from 'vitest';
import { createStatusService, dbSizeBytes, jobCounts, STATUS_CACHE_MS, UPSTREAM_PROBES } from '../src/auth/status.ts';
import { loadConfig } from '../src/config.ts';
import { openDb, type Db } from '../src/db/index.ts';
import { migrate } from '../src/db/migrate.ts';
import { createUpstream } from '../src/http/upstream.ts';

let db: Db | null = null;
afterEach(() => {
  db?.close();
  db = null;
});

/** A status service over an in-memory DB and a fake network that records concurrency per host. */
function setup(opts: { token?: string; delayMs?: number } = {}) {
  db = openDb(':memory:');
  migrate(db);
  const config = loadConfig({ NODE_ENV: 'test', ...(opts.token ? { LICHESS_TOKEN: opts.token } : {}) });
  let clock = Date.UTC(2026, 10, 23, 12);
  const calls: string[] = [];
  const inFlight = new Map<string, number>();
  let maxPerHost = 0;
  const fetch: typeof globalThis.fetch = async input => {
    const url = new URL(String(input));
    calls.push(url.toString());
    inFlight.set(url.host, (inFlight.get(url.host) ?? 0) + 1);
    maxPerHost = Math.max(maxPerHost, inFlight.get(url.host)!);
    await new Promise(r => setTimeout(r, opts.delayMs ?? 5));
    inFlight.set(url.host, inFlight.get(url.host)! - 1);
    if (url.pathname === '/api/account') return Response.json({ id: 'bot' });
    return new Response('ok');
  };
  const upstream = createUpstream({ config, db, fetch, now: () => clock });
  const service = createStatusService({ db, config, upstream, now: () => clock });
  return {
    db,
    service,
    calls,
    maxPerHost: () => maxPerHost,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('status service', () => {
  it('reuses probe results until STATUS_CACHE_MS has passed', async () => {
    const s = setup({ token: 'lip_abc' });
    const first = await s.service.get();
    const n = s.calls.length;
    expect(n).toBe(UPSTREAM_PROBES.length + 1);
    s.advance(STATUS_CACHE_MS - 1);
    expect((await s.service.get()).checkedAt).toBe(first.checkedAt);
    expect(s.calls.length).toBe(n);
    s.advance(1);
    expect((await s.service.get()).checkedAt).toBe(first.checkedAt! + STATUS_CACHE_MS);
    expect(s.calls.length).toBe(2 * n);
    s.service.invalidate();
    await s.service.get();
    expect(s.calls.length).toBe(3 * n);
  });

  it('sends one request at a time per host and coalesces concurrent refreshes', async () => {
    const s = setup({ token: 'lip_abc', delayMs: 20 });
    await Promise.all([s.service.get({ refresh: true }), s.service.get({ refresh: true }), s.service.get()]);
    expect(s.calls.length).toBe(UPSTREAM_PROBES.length + 1);
    expect(s.maxPerHost()).toBe(1);
    // lichess.org gets the token check first, then its probe.
    const lichess = s.calls.filter(u => new URL(u).host === 'lichess.org');
    expect(lichess.map(u => new URL(u).pathname)).toEqual(['/api/account', '/robots.txt']);
  });

  it('counts jobs per status and sizes the database files', () => {
    const s = setup();
    expect(jobCounts(s.db)).toEqual({ queued: 0, running: 0, done: 0, error: 0, cancelled: 0 });
    s.db.run("INSERT INTO jobs (kind, lane, status, created_at) VALUES ('geo', 'local', 'done', 1), ('geo', 'local', 'done', 2)");
    expect(jobCounts(s.db).done).toBe(2);
    expect(dbSizeBytes('/definitely/not/here.db')).toBe(0);
  });
});
