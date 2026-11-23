import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cancelQueuedJobs,
  enqueueJob,
  enqueueSync,
  getJob,
  loadJobCheckpoint,
  saveJobCheckpoint,
  syncDedupeKey,
  getJobHandler,
  JOB_PRIORITY,
  jobWaitingAhead,
  onJobsQueued,
  queuePosition,
  registerJobHandler,
  sourceSyncStatus,
} from '../src/jobs/index.ts';
import { createSource, createUserSession, makeJobContext, makeTestApp, type TestApp } from './helpers.ts';

describe('job queue', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await makeTestApp();
  });
  afterAll(async () => t.close());

  it('enqueues a sync on the source lane with a label', () => {
    const src = createSource(t.db, { kind: 'lichess', key: 'drnykterstein', displayName: 'DrNykterstein' });
    const job = enqueueSync(t.db, src);
    expect(job).toMatchObject({
      kind: 'sync',
      lane: 'lichess',
      status: 'queued',
      priority: JOB_PRIORITY.scheduled,
      label: 'Sync lichess:DrNykterstein',
      queuePosition: 1,
      userId: null,
    });
    expect(getJob(t.db, job.id)).toEqual(job);
  });

  it('cancels the queued jobs of a dedupe key (and their checkpoints), never a running one', () => {
    const src = createSource(t.db, { kind: 'lichess', key: 'to-be-dropped' });
    const queued = enqueueSync(t.db, src);
    saveJobCheckpoint(t.db, queued.id, { since: 1 }); // a sync that yielded its lane and waits again
    expect(cancelQueuedJobs(t.db, syncDedupeKey(src), 1234)).toBe(1);
    expect(getJob(t.db, queued.id)).toMatchObject({ status: 'cancelled', finishedAt: 1234 });
    expect(loadJobCheckpoint(t.db, queued.id)).toBeNull();
    // Nothing queued any more; a running job is left alone.
    expect(cancelQueuedJobs(t.db, syncDedupeKey(src))).toBe(0);
    const running = enqueueSync(t.db, src);
    t.db.run("UPDATE jobs SET status = 'running', started_at = 1 WHERE id = ?", [running.id]);
    expect(cancelQueuedJobs(t.db, syncDedupeKey(src))).toBe(0);
    expect(getJob(t.db, running.id)!.status).toBe('running');
  });

  it('deduplicates active jobs and raises their priority', () => {
    const src = createSource(t.db, { kind: 'chesscom', key: 'hikaru' });
    const { userId } = createUserSession(t.db, { username: 'queue-user' });
    const a = enqueueSync(t.db, src);
    const b = enqueueSync(t.db, src, { userId, priority: JOB_PRIORITY.high });
    expect(b.id).toBe(a.id);
    expect(b.priority).toBe(JOB_PRIORITY.high);
    expect(b.lane).toBe('chesscom');
  });

  it('orders a lane by priority, then age', () => {
    const s1 = createSource(t.db, { kind: 'lichess', key: 'p1' });
    const s2 = createSource(t.db, { kind: 'lichess', key: 'p2' });
    const low = enqueueSync(t.db, s1, { priority: JOB_PRIORITY.background });
    const high = enqueueSync(t.db, s2, { priority: JOB_PRIORITY.high });
    expect(queuePosition(t.db, high.id)).toBe(1);
    expect(queuePosition(t.db, low.id)).toBe(3); // behind `high` and the first test's job
    t.db.run("UPDATE jobs SET status = 'running' WHERE id = ?", [high.id]);
    expect(queuePosition(t.db, high.id)).toBe(0);
    t.db.run("UPDATE jobs SET status = 'done' WHERE id = ?", [high.id]);
    expect(queuePosition(t.db, high.id)).toBeNull();
  });

  it('reports source sync status', () => {
    const never = createSource(t.db, { kind: 'lichess', key: 'never' });
    const idle = createSource(t.db, { kind: 'lichess', key: 'idle' });
    const failed = createSource(t.db, { kind: 'lichess', key: 'failed' });
    const queued = createSource(t.db, { kind: 'chesscom', key: 'queued' });
    t.db.run('UPDATE sources SET last_synced_at = 1 WHERE id = ?', [idle]);
    t.db.run("UPDATE sources SET last_sync_error = 'boom' WHERE id = ?", [failed]);
    const job = enqueueSync(t.db, queued);
    const status = sourceSyncStatus(t.db, [never, idle, failed, queued, 99999]);
    expect(status.get(never)?.state).toBe('never');
    expect(status.get(idle)?.state).toBe('idle');
    expect(status.get(failed)).toMatchObject({ state: 'error', lastError: 'boom' });
    expect(status.get(queued)).toMatchObject({ state: 'queued', jobId: job.id, queuePosition: 2 });
    expect(status.has(99999)).toBe(false);
  });

  it('puts imports on the local lane and labels them', () => {
    const dbId = t.db.run("INSERT INTO databases (name, kind, created_at) VALUES ('My games', 'games', 0)").lastInsertRowid;
    const job = enqueueJob(t.db, 'pgnImport', { databaseId: dbId, file: '/tmp/x.pgn', originalName: 'x.pgn' }, { userId: null });
    expect(job).toMatchObject({ lane: 'local', label: 'Import x.pgn into My games' });
  });

  it('lets modules register handlers and run them with a test context', async () => {
    registerJobHandler('broadcastMonth', async ctx => {
      ctx.progress({ done: 1, total: 1, message: ctx.job.payload.month });
    });
    const handler = getJobHandler('broadcastMonth')!;
    const { ctx, updates } = makeJobContext(t, 'broadcastMonth', { databaseId: 1, month: '2026-10' });
    await handler(ctx);
    expect(updates).toEqual([{ done: 1, total: 1, message: '2026-10' }]);
    expect(ctx.job.lane).toBe('local');
  });
});

describe('job queue notifications and labels', () => {
  let t: TestApp;
  let other: TestApp;
  beforeAll(async () => {
    t = await makeTestApp();
    other = await makeTestApp();
  });
  afterAll(async () => {
    await t.close();
    await other.close();
  });

  it('wakes the workers of the same database only, for new or re-prioritised work', () => {
    const seen: string[] = [];
    const elsewhere: string[] = [];
    const off = onJobsQueued(t.db, lane => seen.push(lane));
    const offOther = onJobsQueued(other.db, lane => elsewhere.push(lane));
    const src = createSource(t.db, { kind: 'chesscom', key: 'notify-me' });
    enqueueSync(t.db, src);
    enqueueSync(t.db, src);
    enqueueJob(t.db, 'pgnImport', { databaseId: 1, file: '/tmp/a.pgn', originalName: null });
    expect(seen).toEqual(['chesscom', 'chesscom', 'local']);
    expect(elsewhere).toEqual([]);
    off();
    enqueueJob(t.db, 'rebuild', { sourceId: src });
    expect(seen).toHaveLength(3);
    offOther();
  });

  it('labels geo jobs and lets a user adopt a system job', () => {
    expect(enqueueJob(t.db, 'geo', { kind: 'chesscom', keys: [] }).label).toBe('Look up chesscom opponents (country, title)');
    expect(enqueueJob(t.db, 'geo', { kind: 'lichess', keys: ['a', 'b'] }).label).toBe('Look up 2 lichess players');
    const src = createSource(t.db, { kind: 'lichess', key: 'adopt-me' });
    const system = enqueueSync(t.db, src);
    const { userId } = createUserSession(t.db, { username: 'adopter' });
    const mine = enqueueSync(t.db, src, { userId });
    expect(mine).toMatchObject({ id: system.id, userId, priority: JOB_PRIORITY.manual });
  });
});

describe('queue order with run_after', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await makeTestApp();
  });
  afterAll(async () => t.close());

  const job = (priority: number, runAfter: number | null = null) =>
    enqueueJob(t.db, 'broadcastMonth', { databaseId: 1, month: '2026-10' }, { priority, runAfter });

  it('puts waiting jobs after the runnable ones and tells a long job when to yield', () => {
    const now = Date.now();
    const rebuild = job(JOB_PRIORITY.scheduled);
    expect(jobWaitingAhead(t.db, rebuild.id)).toBe(false);
    const waitingHigh = job(JOB_PRIORITY.high, now + 60_000);
    const waitingSoon = job(JOB_PRIORITY.background, now + 30_000);
    expect(jobWaitingAhead(t.db, rebuild.id)).toBe(false); // nothing that can run now
    const lower = job(JOB_PRIORITY.background);
    expect(jobWaitingAhead(t.db, rebuild.id)).toBe(false); // runs after it anyway
    expect([rebuild, lower, waitingSoon, waitingHigh].map(j => queuePosition(t.db, j.id))).toEqual([1, 2, 3, 4]);

    const manual = job(JOB_PRIORITY.manual);
    expect(jobWaitingAhead(t.db, rebuild.id)).toBe(true);
    expect(jobWaitingAhead(t.db, manual.id)).toBe(false);
    expect(queuePosition(t.db, manual.id)).toBe(1);
    expect(queuePosition(t.db, waitingHigh.id)).toBe(5);
    // When its time comes, the high-priority job is next again.
    expect(jobWaitingAhead(t.db, rebuild.id, now + 61_000)).toBe(true);
    expect(jobWaitingAhead(t.db, 999_999)).toBe(false);
  });
});
