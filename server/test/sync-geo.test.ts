import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { insertGame } from '../src/chess/store.ts';
import { RequeueJob } from '../src/jobs/index.ts';
import {
  geoHandler,
  pendingLookupCount,
  queueOpponentLookups,
  sweepPendingLookups,
} from '../src/sync/index.ts';
import {
  CHESSCOM_CAP_PAUSE_MS,
  CHESSCOM_LOOKUPS_PER_JOB,
  CHESSCOM_LOOKUPS_PER_RUN,
  enqueuePendingLookups,
  LICHESS_BATCHES_PER_RUN,
  LICHESS_USERS_BATCH,
} from '../src/sync/geo.ts';
import { createSource, makeJobContext, makeTestApp, testGame, type TestApp } from './helpers.ts';
import { fakeFetch, fixtureJson, jsonResponse, statusResponse, type FakeFetch } from './sync-fakes.ts';

const USERS = fixtureJson<unknown[]>('lichess/users-batch.json');

describe('opponent geo lookups', () => {
  let t: TestApp;
  let fake: FakeFetch;

  beforeEach(async () => {
    fake = fakeFetch([
      ['lichess.org/api/users', () => jsonResponse(USERS)],
      [
        /^api\.chess\.com\/pub\/player\/[^/]+$/,
        url => {
          const key = url.pathname.split('/').pop()!;
          if (key === 'gone') return statusResponse(404);
          if (key === 'titled') return jsonResponse({ username: 'titled', url: 'https://www.chess.com/member/Titled', title: 'GM', country: 'https://api.chess.com/pub/country/XS' });
          return jsonResponse({ username: key, url: `https://www.chess.com/member/${key}`, country: 'https://api.chess.com/pub/country/DE' });
        },
      ],
    ]);
    t = await makeTestApp({ fetch: fake.fetch });
  });
  afterEach(async () => t.close());

  const pending = (kind: string) =>
    t.db.all<{ key: string }>('SELECT key FROM players_cache WHERE kind = ? AND fetched_at IS NULL ORDER BY key', [kind]).map(r => r.key);

  it('queues a source’s unknown opponents once and enqueues one job per site', () => {
    const me = createSource(t.db, { kind: 'lichess', key: 'synthplayer' });
    insertGame(t.db, testGame({ white: { name: 'SynthPlayer' }, black: { name: 'SynthRival' } }));
    insertGame(t.db, testGame({ white: { name: 'ExampleFoe' }, black: { name: 'SynthPlayer' } }));
    insertGame(t.db, testGame({ white: { name: 'SynthPlayer' }, black: { name: 'SynthRival' } }));
    t.db.run("INSERT INTO players_cache (kind, key, country, fetched_at) VALUES ('lichess', 'examplefoe', 'SE', 1)");
    const job = queueOpponentLookups(t.db, me, 'lichess');
    expect(pending('lichess')).toEqual(['synthrival']);
    expect(t.db.value("SELECT name FROM players_cache WHERE key = 'synthrival'")).toBe('SynthRival');
    expect(job).toMatchObject({ kind: 'geo', lane: 'lichess', priority: -10, label: 'Look up lichess opponents (country, title)' });
    expect(queueOpponentLookups(t.db, me, 'lichess')?.id).toBe(job!.id);
    expect(queueOpponentLookups(t.db, me, 'chesscom')).toBeNull();
  });

  it('looks Lichess players up in batches and records unknown and closed accounts', async () => {
    for (const key of ['synthrival', 'examplefoe', 'samplepal', 'nobody-here', 'bad key!']) {
      t.db.run("INSERT INTO players_cache (kind, key, name, fetched_at) VALUES ('lichess', ?, ?, NULL)", [key, key]);
    }
    const { ctx, updates } = makeJobContext(t, 'geo', { kind: 'lichess', keys: [] });
    await geoHandler(ctx);
    const call = fake.callsTo('/api/users')[0]!;
    expect(call.method).toBe('POST');
    expect(call.headers.get('content-type')).toBe('text/plain');
    expect(call.body!.split(',').sort()).toEqual(['examplefoe', 'nobody-here', 'samplepal', 'synthrival']);
    const rows = t.db.all('SELECT key, country, title, name, fetched_at IS NOT NULL AS fetched FROM players_cache ORDER BY key');
    expect(rows).toEqual([
      { key: 'bad key!', country: null, title: null, name: 'bad key!', fetched: 1 },
      { key: 'examplefoe', country: null, title: null, name: 'ExampleFoe', fetched: 1 },
      { key: 'nobody-here', country: null, title: null, name: 'nobody-here', fetched: 1 },
      { key: 'samplepal', country: null, title: null, name: 'samplepal', fetched: 1 },
      { key: 'synthrival', country: 'NO', title: 'IM', name: 'SynthRival', fetched: 1 },
    ]);
    expect(updates.at(-1)).toMatchObject({ done: 5, total: 5, counts: { found: 2 } });
    expect(pendingLookupCount(t.db, 'lichess')).toBe(0);
  });

  it('yields the Lichess lane after a chunk of requests', async () => {
    const n = LICHESS_USERS_BATCH * LICHESS_BATCHES_PER_RUN + 5;
    t.db.tx(() => {
      for (let i = 0; i < n; i++) t.db.run("INSERT INTO players_cache (kind, key, fetched_at) VALUES ('lichess', ?, NULL)", [`player${String(i).padStart(5, '0')}`]);
    });
    const { ctx } = makeJobContext(t, 'geo', { kind: 'lichess', keys: [] });
    await expect(geoHandler(ctx)).rejects.toBeInstanceOf(RequeueJob);
    expect(fake.callsTo('/api/users')).toHaveLength(LICHESS_BATCHES_PER_RUN);
    expect(fake.callsTo('/api/users').every(c => c.body!.split(',').length <= LICHESS_USERS_BATCH)).toBe(true);
    expect(pendingLookupCount(t.db, 'lichess')).toBe(5);
  });

  it('looks Chess.com players up one by one, maps countries and backfills titles', async () => {
    const me = createSource(t.db, { kind: 'chesscom', key: 'hikaru' });
    insertGame(t.db, testGame({ origin: 'chesscom', originId: 'cc1', white: { name: 'Hikaru' }, black: { name: 'Titled' } }));
    for (const key of ['titled', 'gone', 'plainuser']) t.db.run("INSERT INTO players_cache (kind, key, fetched_at) VALUES ('chesscom', ?, NULL)", [key]);
    const { ctx } = makeJobContext(t, 'geo', { kind: 'chesscom', keys: [] });
    await geoHandler(ctx);
    // The opponent of a stored game first (decision 20: most recent first), then by name.
    expect(fake.callsTo(/^\/pub\/player\//).map(c => c.url.pathname)).toEqual([
      '/pub/player/titled',
      '/pub/player/gone',
      '/pub/player/plainuser',
    ]);
    expect(t.db.all("SELECT key, country, title, name FROM players_cache WHERE kind = 'chesscom' ORDER BY key")).toEqual([
      { key: 'gone', country: null, title: null, name: null },
      { key: 'plainuser', country: 'DE', title: null, name: 'plainuser' },
      { key: 'titled', country: 'GB', title: 'GM', name: 'Titled' },
    ]);
    expect(t.db.value("SELECT black_title FROM games WHERE origin_id = 'cc1'")).toBe('GM');
    expect(t.db.value('SELECT opp_title FROM player_games WHERE source_id = ?', [me])).toBe('GM');
  });

  it('yields the Chess.com lane after a chunk of lookups and keeps counting', async () => {
    t.db.tx(() => {
      for (let i = 0; i < CHESSCOM_LOOKUPS_PER_RUN + 3; i++) {
        t.db.run("INSERT INTO players_cache (kind, key, fetched_at) VALUES ('chesscom', ?, NULL)", [`user${String(i).padStart(3, '0')}`]);
      }
    });
    const jobId = t.db.run("INSERT INTO jobs (kind, lane, payload_json, status, created_at) VALUES ('geo', 'chesscom', '{}', 'running', 0)").lastInsertRowid;
    const first = makeJobContext(t, 'geo', { kind: 'chesscom', keys: [] }, { jobId });
    await expect(geoHandler(first.ctx)).rejects.toBeInstanceOf(RequeueJob);
    expect(first.updates.at(-1)).toMatchObject({ done: CHESSCOM_LOOKUPS_PER_RUN, total: CHESSCOM_LOOKUPS_PER_RUN + 3 });
    t.db.run('UPDATE jobs SET progress_json = ? WHERE id = ?', [JSON.stringify(first.updates.at(-1)), jobId]);
    const second = makeJobContext(t, 'geo', { kind: 'chesscom', keys: [] }, { jobId });
    await geoHandler(second.ctx);
    expect(second.updates.at(-1)).toMatchObject({ done: CHESSCOM_LOOKUPS_PER_RUN + 3, total: CHESSCOM_LOOKUPS_PER_RUN + 3 });
  });

  it('looks the most recently met Chess.com opponents up first', async () => {
    createSource(t.db, { kind: 'chesscom', key: 'hikaru' });
    const day = (d: number) => Date.UTC(2026, 0, d);
    const game = (id: string, opp: string, d: number) =>
      insertGame(t.db, testGame({ origin: 'chesscom', originId: id, white: { name: 'Hikaru' }, black: { name: opp }, startedAt: day(d) - 600_000, endedAt: day(d) }));
    game('o1', 'oldfoe', 1);
    game('o2', 'newfoe', 20);
    game('o3', 'midfoe', 10);
    game('o4', 'oldfoe', 5); // its latest game counts
    for (const key of ['aaa-nogames', 'midfoe', 'newfoe', 'oldfoe']) t.db.run("INSERT INTO players_cache (kind, key, fetched_at) VALUES ('chesscom', ?, NULL)", [key]);
    await geoHandler(makeJobContext(t, 'geo', { kind: 'chesscom', keys: [] }).ctx);
    expect(fake.callsTo(/^\/pub\/player\//).map(c => c.url.pathname.split('/').pop())).toEqual(['newfoe', 'midfoe', 'oldfoe', 'aaa-nogames']);
  });

  it(`stops a Chess.com job after ${CHESSCOM_LOOKUPS_PER_JOB} lookups and pauses until the next sweep`, async () => {
    t.db.tx(() => {
      for (let i = 0; i < 20; i++) t.db.run("INSERT INTO players_cache (kind, key, fetched_at) VALUES ('chesscom', ?, NULL)", [`user${String(i).padStart(3, '0')}`]);
    });
    // A job that already made all but 10 of its lookups in earlier runs.
    const already = CHESSCOM_LOOKUPS_PER_JOB - 10;
    const jobId = t.db.run(
      "INSERT INTO jobs (kind, lane, payload_json, status, created_at, dedupe_key, progress_json) VALUES ('geo', 'chesscom', '{}', 'running', 0, 'geo:chesscom', ?)",
      [JSON.stringify({ done: already, total: already + 20, message: null })],
    ).lastInsertRowid;
    const run = makeJobContext(t, 'geo', { kind: 'chesscom', keys: [] }, { jobId });
    await geoHandler(run.ctx); // ends normally: no RequeueJob
    expect(fake.callsTo(/^\/pub\/player\//)).toHaveLength(10);
    expect(pendingLookupCount(t.db, 'chesscom')).toBe(10);
    const last = run.updates.at(-1)!;
    expect(last).toMatchObject({ done: CHESSCOM_LOOKUPS_PER_JOB, total: CHESSCOM_LOOKUPS_PER_JOB + 10, counts: { found: 10, capped: 1 } });
    expect(last.message).toMatch(/10 more continue at the next scheduled run/);

    // The worker marks it done with that progress; Chess.com lookups then pause (Lichess does not).
    const now = Date.now();
    t.db.run("UPDATE jobs SET status = 'done', finished_at = ?, progress_json = ? WHERE id = ?", [now, JSON.stringify(last), jobId]);
    t.db.run("INSERT INTO players_cache (kind, key, fetched_at) VALUES ('lichess', 'somebody', NULL)");
    expect(enqueuePendingLookups(t.db, 'chesscom', now)).toBeNull();
    expect(sweepPendingLookups(t.db, now + 30 * 60_000).map(j => j.lane)).toEqual(['lichess']);
    const next = sweepPendingLookups(t.db, now + CHESSCOM_CAP_PAUSE_MS + 1).find(j => j.lane === 'chesscom');
    expect(next).toMatchObject({ kind: 'geo', priority: -10 });
    expect(next!.id).not.toBe(jobId);
  });

  it('looks explicit keys up again and stops when cancelled', async () => {
    t.db.run("INSERT INTO players_cache (kind, key, country, fetched_at) VALUES ('lichess', 'synthrival', 'SE', 5)");
    const { ctx } = makeJobContext(t, 'geo', { kind: 'lichess', keys: ['SynthRival'] });
    await geoHandler(ctx);
    expect(t.db.value("SELECT country FROM players_cache WHERE key = 'synthrival'")).toBe('NO');

    t.db.run("INSERT INTO players_cache (kind, key, fetched_at) VALUES ('chesscom', 'someone', NULL)");
    const c = makeJobContext(t, 'geo', { kind: 'chesscom', keys: [] });
    c.abort();
    await expect(geoHandler(c.ctx)).rejects.toThrow();
    expect(pendingLookupCount(t.db, 'chesscom')).toBe(1);
  });

  it('sweeps pending lookups that no job handles, but not right after a failure', () => {
    t.db.run("INSERT INTO players_cache (kind, key, fetched_at) VALUES ('lichess', 'a', NULL), ('chesscom', 'b', NULL)");
    const now = Date.now();
    t.db.run("INSERT INTO jobs (kind, lane, payload_json, status, created_at, finished_at, dedupe_key) VALUES ('geo', 'chesscom', '{}', 'error', ?, ?, 'geo:chesscom')", [now, now - 60_000]);
    const jobs = sweepPendingLookups(t.db, now);
    expect(jobs.map(j => j.lane)).toEqual(['lichess']);
    expect(sweepPendingLookups(t.db, now).map(j => j.id)).toEqual([jobs[0]!.id]);
    expect(sweepPendingLookups(t.db, now + 2 * 60 * 60_000).map(j => j.lane)).toEqual(['lichess', 'chesscom']);
  });
});
