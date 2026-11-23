import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JobProgress } from '@outpost/shared/api';
import { UpstreamError } from '../src/http/upstream.ts';
import {
  cancelJob,
  enqueueJob,
  enqueueSync,
  getJob,
  JobAbortedError,
  JobRunner,
  listAdminJobs,
  loadJobCheckpoint,
  pruneFinishedJobs,
  registerJobHandler,
  RequeueJob,
  requeueStaleRunning,
  retryJob,
  saveJobCheckpoint,
  type JobContext,
  type JobRow,
} from '../src/jobs/index.ts';
import { createSource, makeTestApp, type TestApp } from './helpers.ts';
import { fakeFetch, fixtureJson, fixtureNdjson, jsonResponse, ndjsonResponse } from './sync-fakes.ts';

/** A promise with its resolve function. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Polls until `fn` is truthy (real time), failing after `ms`. */
async function until<T>(fn: () => T, ms = 3000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise(r => setTimeout(r, 10));
  }
}

const row = (t: TestApp, id: number) =>
  t.db.get<Pick<JobRow, 'status' | 'attempts' | 'run_after' | 'error' | 'progress_json' | 'started_at' | 'finished_at'>>(
    'SELECT status, attempts, run_after, error, progress_json, started_at, finished_at FROM jobs WHERE id = ?',
    [id],
  )!;

describe('job workers', () => {
  let t: TestApp;
  let offset: number;
  let runner: JobRunner;
  const now = (): number => Date.now() + offset;

  beforeEach(async () => {
    t = await makeTestApp();
    offset = 0;
    runner = new JobRunner({
      db: t.db,
      config: t.config,
      upstream: t.app.upstream,
      log: t.app.log,
      now,
      maxAttempts: 3,
      idlePollMs: 60_000,
      shutdownGraceMs: 300,
    });
  });
  afterEach(async () => {
    await runner.stop();
    await t.close();
  });

  const round = (roundId: string, opts: Parameters<typeof enqueueJob>[3] = {}) => enqueueJob(t.db, 'broadcastRound', { databaseId: 1, roundId }, opts);

  it('claims by priority, then age, and waits for run_after', async () => {
    const ran: string[] = [];
    registerJobHandler('broadcastRound', async ctx => void ran.push(ctx.job.payload.roundId));
    round('low', { priority: 0 });
    round('high-1', { priority: 10 });
    round('high-2', { priority: 10 });
    const later = round('later', { priority: 20, runAfter: Date.now() + 60_000 });
    while (await runner.runNext('lichess'));
    expect(ran).toEqual(['high-1', 'high-2', 'low']);
    expect(row(t, later.id).status).toBe('queued');
    offset = 61_000;
    expect(await runner.runNext('lichess')).toBe(true);
    expect(ran.at(-1)).toBe('later');
    expect(await runner.runNext('chesscom')).toBe(false);
  });

  it('marks success, counts attempts and throttles progress writes', async () => {
    let seenMidway: JobProgress | null = null;
    registerJobHandler('broadcastRound', async (ctx: JobContext<'broadcastRound'>) => {
      for (let i = 1; i <= 5; i++) ctx.progress({ done: i, total: 5, message: `step ${i}` });
      seenMidway = JSON.parse(t.db.value<string>('SELECT progress_json FROM jobs WHERE id = ?', [ctx.job.id])!);
      expect(ctx.job.attempts).toBe(1);
      expect(ctx.signal.aborted).toBe(false);
    });
    const job = round('r');
    await runner.runNext('lichess');
    expect(seenMidway).toMatchObject({ done: 1 }); // later updates waited for the interval
    expect(row(t, job.id)).toMatchObject({ status: 'done', attempts: 1, error: null });
    expect(JSON.parse(row(t, job.id).progress_json!)).toEqual({ done: 5, total: 5, message: 'step 5' });
    expect(getJob(t.db, job.id)).toMatchObject({ status: 'done', queuePosition: null });
  });

  it('re-queues rate-limited jobs at retryAt without counting a failure', async () => {
    const retryAt = Date.now() + 90_000;
    registerJobHandler('broadcastRound', async ctx => {
      if (ctx.job.payload.roundId === 'with')
        throw new UpstreamError('rate_limited', 'lichess.org', 'lichess.org answered 429 Too Many Requests', { status: 429, retryAt });
      throw new UpstreamError('rate_limited', 'lichess.org', 'cooling down', { status: 429 });
    });
    const a = round('with');
    await runner.runNext('lichess');
    expect(row(t, a.id)).toMatchObject({ status: 'queued', attempts: 0, run_after: retryAt, started_at: null });
    expect(getJob(t.db, a.id)).toMatchObject({ status: 'queued', startedAt: null });
    expect(row(t, a.id).error).toMatch(/429.*waiting until/);
    t.db.run("UPDATE jobs SET status = 'done' WHERE id = ?", [a.id]);
    const b = round('without');
    const before = now();
    await runner.runNext('lichess');
    expect(row(t, b.id).run_after).toBeGreaterThanOrEqual(before + 60_000);
  });

  it('does not repeat the retry time the cool-down message already names', async () => {
    const retryAt = Date.now() + 120_000;
    const iso = new Date(retryAt).toISOString();
    registerJobHandler('broadcastRound', async () => {
      throw new UpstreamError('rate_limited', 'lichess.org', `lichess.org is rate limiting Outpost; retry after ${iso}`, { retryAt });
    });
    const job = round('cooling');
    await runner.runNext('lichess');
    expect(row(t, job.id)).toMatchObject({ status: 'queued', run_after: retryAt, error: `lichess.org is rate limiting Outpost; retry after ${iso}` });
  });

  it('backs off exponentially on network errors and 5xx, then gives up', async () => {
    let calls = 0;
    registerJobHandler('broadcastRound', async () => {
      calls++;
      if (calls === 1) throw new UpstreamError('network', 'lichess.org', 'Could not reach lichess.org: ECONNRESET');
      throw new UpstreamError('status', 'lichess.org', 'lichess.org answered 502', { status: 502 });
    });
    const job = round('flaky');
    const t0 = now();
    await runner.runNext('lichess');
    expect(row(t, job.id)).toMatchObject({ status: 'queued', attempts: 1, started_at: null });
    expect(row(t, job.id).run_after! - t0).toBeGreaterThanOrEqual(30_000);
    expect(row(t, job.id).run_after! - t0).toBeLessThan(31_000);
    expect(row(t, job.id).error).toMatch(/ECONNRESET \(attempt 1 of 3/);
    expect(await runner.runNext('lichess')).toBe(false); // still waiting

    offset += 31_000;
    const t1 = now();
    await runner.runNext('lichess');
    expect(row(t, job.id)).toMatchObject({ status: 'queued', attempts: 2 });
    expect(row(t, job.id).run_after! - t1).toBeGreaterThanOrEqual(60_000);

    offset += 61_000;
    await runner.runNext('lichess');
    expect(row(t, job.id)).toMatchObject({ status: 'error', attempts: 3, error: 'lichess.org answered 502', run_after: null });
    expect(calls).toBe(3);
  });

  it('fails at once on errors that retrying will not fix', async () => {
    registerJobHandler('broadcastRound', async ctx => {
      if (ctx.job.payload.roundId === '404') throw new UpstreamError('status', 'lichess.org', 'lichess.org answered 404', { status: 404 });
      if (ctx.job.payload.roundId === 'token') throw new UpstreamError('no_token', 'lichess.org', 'A Lichess API token is required');
      throw new Error('bug');
    });
    for (const [id, msg] of [
      ['404', 'answered 404'],
      ['token', 'token is required'],
      ['bug', 'bug'],
    ] as const) {
      const job = round(id);
      await runner.runNext('lichess');
      expect(row(t, job.id)).toMatchObject({ status: 'error', attempts: 1 });
      expect(row(t, job.id).error).toContain(msg);
    }
  });

  it('fails jobs without a handler or with a broken payload', async () => {
    const a = t.db.run("INSERT INTO jobs (kind, lane, payload_json, created_at) VALUES ('noSuchKind', 'local', '{}', 0)").lastInsertRowid;
    await runner.runNext('local');
    expect(row(t, a)).toMatchObject({ status: 'error', error: 'No handler is registered for "noSuchKind" jobs' });
    registerJobHandler('broadcastMonth', async () => {});
    const b = t.db.run("INSERT INTO jobs (kind, lane, payload_json, created_at) VALUES ('broadcastMonth', 'local', '{oops', 0)").lastInsertRowid;
    await runner.runNext('local');
    expect(row(t, b)).toMatchObject({ status: 'error', error: 'The job payload is not valid JSON' });
  });

  it('lets a handler yield its lane with RequeueJob', async () => {
    let runs = 0;
    registerJobHandler('broadcastRound', async () => {
      runs++;
      if (runs === 1) throw new RequeueJob('chunk done');
    });
    const job = round('yield');
    await runner.runNext('lichess');
    expect(row(t, job.id)).toMatchObject({ status: 'queued', attempts: 0, run_after: null });
    await runner.runNext('lichess');
    expect(row(t, job.id)).toMatchObject({ status: 'done', attempts: 1 });
  });

  it('cancels queued jobs and aborts running ones', async () => {
    registerJobHandler('broadcastRound', async ctx => {
      if (ctx.job.payload.roundId === 'stubborn') {
        started.resolve();
        await release.promise; // ignores the signal and returns normally
        return;
      }
      started.resolve();
      await new Promise<void>((_, reject) => ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason)));
    });
    let started = deferred();
    let release = deferred();
    const queued = round('queued');
    expect(cancelJob(t.db, queued.id, now())).toMatchObject({ status: 'cancelled', queuePosition: null });
    expect(await runner.runNext('lichess')).toBe(false);

    const running = round('running');
    const run = runner.runNext('lichess');
    await started.promise;
    expect(runner.runningJobIds).toEqual([running.id]);
    expect(cancelJob(t.db, running.id, now(), id => runner.abortJob(id))).toMatchObject({ status: 'cancelled' });
    await run;
    expect(row(t, running.id).status).toBe('cancelled');

    started = deferred();
    release = deferred();
    const stubborn = round('stubborn');
    const run2 = runner.runNext('lichess');
    await started.promise;
    cancelJob(t.db, stubborn.id, now(), id => runner.abortJob(id));
    release.resolve();
    await run2;
    expect(row(t, stubborn.id).status).toBe('cancelled');
    expect(() => cancelJob(t.db, stubborn.id, now())).toThrow(/already cancelled/);
    expect(cancelJob(t.db, 999_999, now())).toBeNull();
  });

  it('retries finished jobs, runs backed-off jobs now, and respects dedupe keys', async () => {
    registerJobHandler('broadcastRound', async () => {
      throw new Error('boom');
    });
    const job = round('again', { dedupeKey: 'round:again' });
    await runner.runNext('lichess');
    expect(row(t, job.id).status).toBe('error');
    expect(retryJob(t.db, job.id)).toMatchObject({ id: job.id, status: 'queued', error: null, progress: null, queuePosition: 1 });
    expect(row(t, job.id).attempts).toBe(0);

    // A queued job waiting for its backoff runs as soon as possible.
    t.db.run('UPDATE jobs SET run_after = ? WHERE id = ?', [Date.now() + 3_600_000, job.id]);
    expect(retryJob(t.db, job.id)?.id).toBe(job.id);
    expect(row(t, job.id).run_after).toBeNull();

    // A finished job whose dedupe key is taken by an active job returns that job.
    await runner.runNext('lichess');
    const other = round('again', { dedupeKey: 'round:again' });
    expect(other.id).not.toBe(job.id);
    expect(retryJob(t.db, job.id)?.id).toBe(other.id);
    expect(row(t, job.id).status).toBe('error');

    t.db.run("UPDATE jobs SET status = 'running' WHERE id = ?", [other.id]);
    expect(() => retryJob(t.db, other.id)).toThrow(/running/);
    expect(retryJob(t.db, 999_999)).toBeNull();
  });

  it('re-queues jobs a crash left running when it starts', async () => {
    const a = t.db.run("INSERT INTO jobs (kind, lane, payload_json, status, attempts, created_at, started_at) VALUES ('broadcastRound', 'lichess', '{}', 'running', 1, 0, 1)").lastInsertRowid;
    const b = t.db.run("INSERT INTO jobs (kind, lane, payload_json, status, attempts, created_at, started_at) VALUES ('broadcastRound', 'lichess', '{}', 'running', 3, 0, 1)").lastInsertRowid;
    registerJobHandler('broadcastRound', async () => {
      await new Promise(() => {}); // keep the lane busy; stop() re-queues it
    });
    runner.start();
    expect(row(t, b)).toMatchObject({ status: 'error', error: 'Interrupted by a server restart too many times' });
    await until(() => row(t, a).status === 'running');
    await runner.stop();
    expect(row(t, a)).toMatchObject({ status: 'queued', attempts: 1, started_at: null });
  });

  it('clears started_at when a restart re-queues a job', async () => {
    const a = t.db.run("INSERT INTO jobs (kind, lane, payload_json, status, attempts, created_at, started_at) VALUES ('broadcastRound', 'chesscom', '{}', 'running', 1, 0, 5)").lastInsertRowid;
    expect(requeueStaleRunning(t.db, 3, now())).toBe(1);
    expect(row(t, a)).toMatchObject({ status: 'queued', attempts: 1, started_at: null });
    expect(getJob(t.db, a)?.startedAt).toBeNull();
  });

  it('aborts running handlers on shutdown and puts their jobs back in the queue', async () => {
    const started = deferred<AbortSignal>();
    registerJobHandler('broadcastRound', async ctx => {
      started.resolve(ctx.signal);
      await new Promise<void>((_, reject) => ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason)));
    });
    const job = round('long');
    runner.start();
    const signal = await started.promise;
    await runner.stop();
    expect(signal.reason).toBeInstanceOf(JobAbortedError);
    expect((signal.reason as JobAbortedError).why).toBe('shutdown');
    expect(row(t, job.id)).toMatchObject({ status: 'queued', attempts: 0, started_at: null });
    expect(runner.started).toBe(false);
  });

  it('counts jobs waiting for run_after behind the runnable ones in queue positions and lists', async () => {
    registerJobHandler('broadcastRound', async () => {
      throw new UpstreamError('status', 'lichess.org', 'lichess.org answered 502', { status: 502 });
    });
    const backoff = round('backoff', { priority: 10 });
    await runner.runNext('lichess'); // 502 → waits ~30 s
    expect(row(t, backoff.id)).toMatchObject({ status: 'queued' });
    const a = round('a', { priority: 0 });
    const b = round('b', { priority: 0 });
    const later = round('later', { priority: 20, runAfter: now() + 3_600_000 });
    // The runnable jobs come first; the waiting ones follow by run_after, whatever their priority.
    expect([a, b, backoff, later].map(j => getJob(t.db, j.id)?.queuePosition)).toEqual([1, 2, 3, 4]);
    expect(listAdminJobs(t.db, { status: 'queued', page: 1, pageSize: 10 }).jobs.map(j => j.id)).toEqual([a.id, b.id, backoff.id, later.id]);
    // Once its backoff is over, the high-priority job is first again.
    t.db.run('UPDATE jobs SET run_after = ? WHERE id = ?', [Date.now() - 1, backoff.id]);
    expect([a, b, backoff, later].map(j => getJob(t.db, j.id)?.queuePosition)).toEqual([2, 3, 1, 4]);
  });

  it('keeps a job’s checkpoint while it is re-queued and drops it when the job ends or is retried', async () => {
    const seen: (object | null)[] = [];
    registerJobHandler('broadcastMonth', async ctx => {
      const cp = loadJobCheckpoint<{ step: number }>(ctx.db, ctx.job.id);
      seen.push(cp);
      const step = (cp?.step ?? 0) + 1;
      saveJobCheckpoint(ctx.db, ctx.job.id, { step });
      if (step < 3) throw new RequeueJob(`step ${step}`);
      if (ctx.job.payload.month === '2026-01') throw new Error('fails at the end');
    });
    const ok = enqueueJob(t.db, 'broadcastMonth', { databaseId: 1, month: '2026-02' });
    while (await runner.runNext('local'));
    expect(seen).toEqual([null, { step: 1 }, { step: 2 }]);
    expect(row(t, ok.id).status).toBe('done');
    expect(loadJobCheckpoint(t.db, ok.id)).toBeNull();

    seen.length = 0;
    const failing = enqueueJob(t.db, 'broadcastMonth', { databaseId: 1, month: '2026-01' });
    while (await runner.runNext('local'));
    expect(row(t, failing.id).status).toBe('error');
    expect(loadJobCheckpoint(t.db, failing.id)).toBeNull();
    saveJobCheckpoint(t.db, failing.id, { step: 2 }); // e.g. written after an admin cancel
    retryJob(t.db, failing.id);
    expect(loadJobCheckpoint(t.db, failing.id)).toBeNull();

    // Checkpoints of jobs that are gone or over are pruned.
    saveJobCheckpoint(t.db, 424242, { step: 1 });
    saveJobCheckpoint(t.db, ok.id, { step: 1 });
    const queued = enqueueJob(t.db, 'broadcastMonth', { databaseId: 1, month: '2026-03' });
    saveJobCheckpoint(t.db, queued.id, { step: 1 });
    pruneFinishedJobs(t.db, Date.now(), { doneMs: 86_400_000, errorMs: 86_400_000 });
    expect(t.db.all<{ job_id: number }>('SELECT job_id FROM job_checkpoints').map(r => r.job_id)).toEqual([queued.id]);
  });

  it('wakes on enqueue and on run_after instead of polling', async () => {
    const ran = deferred<string>();
    const later = deferred<number>();
    registerJobHandler('broadcastRound', async ctx => ran.resolve(ctx.job.payload.roundId));
    registerJobHandler('broadcastMonth', async () => later.resolve(Date.now()));
    runner.start(); // idle poll is 60 s: only a notification can make this fast
    await new Promise(r => setTimeout(r, 20));
    round('now');
    expect(await Promise.race([ran.promise, new Promise(r => setTimeout(() => r('timeout'), 1000))])).toBe('now');

    const due = Date.now() + 150;
    enqueueJob(t.db, 'broadcastMonth', { databaseId: 1, month: '2026-10' }, { runAfter: due });
    const at = await Promise.race([later.promise, new Promise<number>(r => setTimeout(() => r(-1), 2000))]);
    expect(at).toBeGreaterThanOrEqual(due);
  });
});

describe('workers inside the app', () => {
  it('start with OUTPOST_WORKERS, run a real sync and its geo lookups, and stop on close', async () => {
    const fake = fakeFetch([
      ['lichess.org/api/user/synthplayer', () => jsonResponse(fixtureJson('lichess/synthplayer-user.json'))],
      ['lichess.org/api/games/user/synthplayer', () => ndjsonResponse(fixtureNdjson('lichess/synthplayer-games.ndjson'))],
      ['lichess.org/api/users', () => jsonResponse(fixtureJson('lichess/users-batch.json'))],
    ]);
    const t = await makeTestApp({ env: { OUTPOST_WORKERS: 'true' }, fetch: fake.fetch });
    try {
      const src = createSource(t.db, { kind: 'lichess', key: 'synthplayer' });
      const job = enqueueSync(t.db, src);
      await until(() => getJob(t.db, job.id)?.status === 'done');
      expect(getJob(t.db, job.id)?.progress?.counts).toMatchObject({ imported: 10 });
      const geo = await until(() => t.db.get<{ id: number; status: string }>("SELECT id, status FROM jobs WHERE kind = 'geo' AND status = 'done'"));
      expect(geo.status).toBe('done');
      expect(t.db.value("SELECT country FROM players_cache WHERE kind = 'lichess' AND key = 'synthrival'")).toBe('NO');
      expect(t.db.value('SELECT last_synced_at IS NOT NULL FROM sources WHERE id = ?', [src])).toBe(1);
    } finally {
      await t.close();
    }
  });

  it('do not start in tests by default', async () => {
    const t = await makeTestApp();
    try {
      const src = createSource(t.db, { kind: 'lichess', key: 'synthplayer' });
      const job = enqueueSync(t.db, src);
      await new Promise(r => setTimeout(r, 50));
      expect(getJob(t.db, job.id)?.status).toBe('queued');
    } finally {
      await t.close();
    }
  });
});
