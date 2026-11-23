import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  enqueueJob,
  enqueueSync,
  getJob,
  getJobHandler,
  JOB_PRIORITY,
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
