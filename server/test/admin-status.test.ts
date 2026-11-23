import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canCountInWorker, countHeavyRows, countHeavyRowsInWorker } from '../src/auth/rowCounts.ts';
import {
  createStatusService,
  dbSizeBytes,
  httpProblem,
  jobCounts,
  STATUS_CACHE_MS,
  STATUS_REFRESH_MIN_MS,
  UPSTREAM_PROBES,
} from '../src/auth/status.ts';
import { insertGame } from '../src/chess/store.ts';
import { loadConfig } from '../src/config.ts';
import { openDb, type Db } from '../src/db/index.ts';
import { migrate } from '../src/db/migrate.ts';
import { createUpstream } from '../src/http/upstream.ts';
import { testGame } from './helpers.ts';

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

  it('ignores a refresh within STATUS_REFRESH_MIN_MS of the last run', async () => {
    const s = setup({ token: 'lip_abc' });
    const first = await s.service.get({ refresh: true });
    const n = s.calls.length;
    s.advance(STATUS_REFRESH_MIN_MS - 1);
    expect((await s.service.get({ refresh: true })).checkedAt).toBe(first.checkedAt);
    expect(s.calls.length).toBe(n);
    s.advance(1);
    expect((await s.service.get({ refresh: true })).checkedAt).toBe(first.checkedAt! + STATUS_REFRESH_MIN_MS);
    expect(s.calls.length).toBe(2 * n);
  });

  it('describes HTTP problems: 4xx reachable, 5xx down', () => {
    expect(httpProblem(200)).toBeNull();
    expect(httpProblem(304)).toBeNull();
    expect(httpProblem(404)).toMatch(/^HTTP 404: reachable/);
    expect(httpProblem(401)).toMatch(/token/);
    expect(httpProblem(502)).toMatch(/^HTTP 502: the server has a problem/);
  });

  it('counts jobs per status and sizes the database files', () => {
    const s = setup();
    expect(jobCounts(s.db)).toEqual({ queued: 0, running: 0, done: 0, error: 0, cancelled: 0 });
    s.db.run("INSERT INTO jobs (kind, lane, status, created_at) VALUES ('geo', 'local', 'done', 1), ('geo', 'local', 'done', 2)");
    expect(jobCounts(s.db).done).toBe(2);
    expect(dbSizeBytes('/definitely/not/here.db')).toBe(0);
  });
});

describe('row counts', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** A migrated database file with a few games of each kind. */
  function fileDb(): { db: Db; path: string } {
    const dir = mkdtempSync(join(tmpdir(), 'outpost-counts-'));
    dirs.push(dir);
    const path = join(dir, 'outpost.db');
    const d = openDb(path);
    migrate(d);
    insertGame(d, testGame());
    insertGame(d, testGame());
    insertGame(d, testGame({ origin: 'reference', originId: 'ref:counts' }));
    return { db: d, path };
  }

  it('counts in a worker thread with its own read-only connection', async () => {
    const f = fileDb();
    try {
      const inline = countHeavyRows(f.db);
      expect(inline).toEqual({ games: 2, referenceGames: 1, positions: f.db.value('SELECT COUNT(*) FROM positions') });
      expect(await countHeavyRowsInWorker(f.path)).toEqual(inline);
      // The server's connection keeps writing meanwhile (WAL).
      const counting = countHeavyRowsInWorker(f.path);
      insertGame(f.db, testGame());
      expect((await counting).games).toBeGreaterThanOrEqual(2);
    } finally {
      f.db.close();
    }
  });

  it('rejects for a database it cannot open, and when aborted', async () => {
    await expect(countHeavyRowsInWorker(join(tmpdir(), 'outpost-no-such-dir', 'x.db'))).rejects.toThrow();
    const f = fileDb();
    try {
      const ac = new AbortController();
      const run = countHeavyRowsInWorker(f.path, { signal: ac.signal });
      ac.abort(new Error('stop'));
      await expect(run).rejects.toThrow('stop');
      await expect(countHeavyRowsInWorker(f.path, { signal: ac.signal })).rejects.toThrow('stop');
    } finally {
      f.db.close();
    }
  });

  it('knows which databases a second connection can open', () => {
    expect(canCountInWorker('/data/outpost.db')).toBe(true);
    expect(canCountInWorker(':memory:')).toBe(false);
    expect(canCountInWorker('')).toBe(false);
    expect(canCountInWorker('file::memory:?cache=shared')).toBe(false);
  });

  it('the status service uses the worker for a file database and stops it on close', async () => {
    const f = fileDb();
    try {
      const config = loadConfig({ NODE_ENV: 'test' });
      const fetch: typeof globalThis.fetch = async () => new Response('ok');
      const upstream = createUpstream({ config, db: f.db, fetch });
      const service = createStatusService({ db: f.db, config, upstream });
      expect((await service.get()).counts).toMatchObject({ games: 2, referenceGames: 1 });
      await service.close();
    } finally {
      f.db.close();
    }
  });
});
