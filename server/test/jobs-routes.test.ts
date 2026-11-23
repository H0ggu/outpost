import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API_ROUTES, type AdminJobsPage, type JobInfo, type MyJobsResponse } from '@outpost/shared/api';
import { enqueueJob, enqueueSync, JOB_PRIORITY } from '../src/jobs/index.ts';
import { createSource, createUserSession, makeTestApp, mutationHeaders, type TestApp } from './helpers.ts';

describe('jobs endpoints', () => {
  let t: TestApp;
  let admin: { userId: number; cookie: string };
  let alice: { userId: number; cookie: string };
  let bob: { userId: number; cookie: string };
  const ids: Record<string, number> = {};

  beforeAll(async () => {
    t = await makeTestApp();
    admin = createUserSession(t.db, { username: 'admin', role: 'admin' });
    alice = createUserSession(t.db, { username: 'alice' });
    bob = createUserSession(t.db, { username: 'bob' });
    const now = Date.now();
    const profile = (slug: string, owner: number) =>
      t.db.run('INSERT INTO profiles (slug, display_name, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [slug, slug, owner, now, now])
        .lastInsertRowid;
    const aliceProfile = profile('alice-prep', alice.userId);
    const bobProfile = profile('bob-prep', bob.userId);
    const s1 = createSource(t.db, { kind: 'lichess', key: 'opponent-one' });
    const s2 = createSource(t.db, { kind: 'lichess', key: 'opponent-two' });
    const s3 = createSource(t.db, { kind: 'chesscom', key: 'opponent-three' });
    t.db.run('INSERT INTO profile_sources (profile_id, source_id) VALUES (?, ?), (?, ?), (?, ?)', [aliceProfile, s1, aliceProfile, s3, bobProfile, s2]);
    const aliceDb = t.db.run("INSERT INTO databases (owner_user_id, name, kind, created_at) VALUES (?, 'Alice games', 'games', 0)", [alice.userId]).lastInsertRowid;

    ids.sync1 = enqueueSync(t.db, s1).id; // system job for alice's profile
    ids.sync2 = enqueueSync(t.db, s2, { userId: bob.userId }).id; // bob's (manual priority: a user asked)
    ids.sync3 = enqueueSync(t.db, s3, { priority: JOB_PRIORITY.high }).id; // alice's profile, chesscom lane
    ids.import = enqueueJob(t.db, 'pgnImport', { databaseId: aliceDb, file: '/tmp/x.pgn', originalName: 'x.pgn' }, { userId: alice.userId }).id;
    ids.geo = enqueueJob(t.db, 'geo', { kind: 'lichess', keys: [] }, { priority: JOB_PRIORITY.background }).id;
    ids.done = enqueueJob(t.db, 'rebuild', { sourceId: s1 }).id;
    t.db.run("UPDATE jobs SET status = 'done', finished_at = ? WHERE id = ?", [now, ids.done]);
    ids.failed = enqueueJob(t.db, 'rebuild', { sourceId: s2 }).id;
    t.db.run("UPDATE jobs SET status = 'error', error = 'boom', finished_at = ? WHERE id = ?", [now + 1, ids.failed]);
  });
  afterAll(async () => t.close());

  const get = (url: string, cookie?: string) => t.app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });
  const post = (url: string, cookie?: string) => t.app.inject({ method: 'POST', url, headers: { ...mutationHeaders, ...(cookie ? { cookie } : {}) } });

  it('requires a session for /api/jobs/mine and an admin for the admin endpoints', async () => {
    expect((await get(API_ROUTES.jobsMine)).statusCode).toBe(401);
    expect((await get(API_ROUTES.admin.jobs)).statusCode).toBe(401);
    expect((await get(API_ROUTES.admin.jobs, alice.cookie)).statusCode).toBe(403);
    expect((await post(API_ROUTES.admin.jobRetry(ids.failed!), alice.cookie)).statusCode).toBe(403);
    expect((await post(API_ROUTES.admin.jobCancel(ids.sync1!), bob.cookie)).json()).toEqual({ error: { code: 'forbidden', message: 'Admins only' } });
    const noCsrf = await t.app.inject({ method: 'POST', url: API_ROUTES.admin.jobCancel(ids.sync1!), headers: { cookie: admin.cookie } });
    expect(noCsrf.statusCode).toBe(403);
  });

  it('lists my queued and running jobs with queue positions', async () => {
    const res = await get(API_ROUTES.jobsMine, alice.cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json<MyJobsResponse>();
    expect(body.jobs.map(j => j.id).sort()).toEqual([ids.sync1, ids.sync3, ids.import].sort());
    const sync1 = body.jobs.find(j => j.id === ids.sync1)!;
    expect(sync1).toMatchObject({ kind: 'sync', lane: 'lichess', status: 'queued', queuePosition: 2, label: 'Sync lichess:opponent-one' });
    expect(body.jobs.find(j => j.id === ids.import)).toMatchObject({ lane: 'local', userId: alice.userId, queuePosition: 1 });
    const bobs = (await get(API_ROUTES.jobsMine, bob.cookie)).json<MyJobsResponse>();
    expect(bobs.jobs.map(j => j.id)).toEqual([ids.sync2]);
    expect(bobs.jobs[0]!.queuePosition).toBe(1);
  });

  it('lists all jobs for the admin with filters, paging and counts', async () => {
    const all = (await get(API_ROUTES.admin.jobs, admin.cookie)).json<AdminJobsPage>();
    expect(all).toMatchObject({ total: 7, page: 1, pageSize: 50, counts: { queued: 5, running: 0, done: 1, error: 1, cancelled: 0 } });
    // Queue order first (priority, then age), finished jobs last, newest first.
    expect(all.jobs.map(j => j.id)).toEqual([ids.sync3, ids.sync2, ids.import, ids.sync1, ids.geo, ids.failed, ids.done]);

    const lichess = (await get(`${API_ROUTES.admin.jobs}?lane=lichess&status=queued`, admin.cookie)).json<AdminJobsPage>();
    expect(lichess.jobs.map(j => j.id)).toEqual([ids.sync2, ids.sync1, ids.geo]);
    expect(lichess.counts).toEqual({ queued: 3, running: 0, done: 0, error: 0, cancelled: 0 }); // rebuilds run on the local lane
    expect(lichess.total).toBe(3);

    const page2 = (await get(`${API_ROUTES.admin.jobs}?pageSize=2&page=2`, admin.cookie)).json<AdminJobsPage>();
    expect(page2).toMatchObject({ total: 7, page: 2, pageSize: 2 });
    expect(page2.jobs.map(j => j.id)).toEqual([ids.import, ids.sync1]);

    const rebuilds = (await get(`${API_ROUTES.admin.jobs}?kind=rebuild`, admin.cookie)).json<AdminJobsPage>();
    expect(rebuilds.jobs.map(j => [j.id, j.status, j.error])).toEqual([
      [ids.failed, 'error', 'boom'],
      [ids.done, 'done', null],
    ]);

    const bad = await get(`${API_ROUTES.admin.jobs}?status=exploded`, admin.cookie);
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('validation');
    expect((await get(`${API_ROUTES.admin.jobs}?pageSize=1000`, admin.cookie)).statusCode).toBe(400);
  });

  it('retries and cancels jobs, answering JobInfo', async () => {
    const retried = await post(API_ROUTES.admin.jobRetry(ids.failed!), admin.cookie);
    expect(retried.statusCode).toBe(200);
    // Behind the manual-priority import on the local lane.
    expect(retried.json<JobInfo>()).toMatchObject({ id: ids.failed, status: 'queued', error: null, queuePosition: 2 });
    // A job waiting out a backoff doesn't count ahead of runnable ones: the import now waits.
    t.db.run('UPDATE jobs SET run_after = ? WHERE id = ?', [Date.now() + 30_000, ids.import!]);
    const again1 = await post(API_ROUTES.admin.jobRetry(ids.failed!), admin.cookie);
    expect(again1.json<JobInfo>()).toMatchObject({ id: ids.failed, status: 'queued', queuePosition: 1 });
    const mine = (await get(API_ROUTES.jobsMine, alice.cookie)).json<MyJobsResponse>();
    expect(mine.jobs.find(j => j.id === ids.import)).toMatchObject({ queuePosition: 2 });
    const local = (await get(`${API_ROUTES.admin.jobs}?lane=local&status=queued`, admin.cookie)).json<AdminJobsPage>();
    expect(local.jobs.map(j => j.id)).toEqual([ids.failed, ids.import]);

    const cancelled = await post(API_ROUTES.admin.jobCancel(ids.geo!), admin.cookie);
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json<JobInfo>()).toMatchObject({ id: ids.geo, status: 'cancelled', queuePosition: null });
    expect(cancelled.json<JobInfo>().finishedAt).toBeTypeOf('number');

    const again = await post(API_ROUTES.admin.jobCancel(ids.geo!), admin.cookie);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('conflict');

    t.db.run("UPDATE jobs SET status = 'running' WHERE id = ?", [ids.sync2!]);
    expect((await post(API_ROUTES.admin.jobRetry(ids.sync2!), admin.cookie)).statusCode).toBe(409);
    const stopped = await post(API_ROUTES.admin.jobCancel(ids.sync2!), admin.cookie);
    expect(stopped.json<JobInfo>()).toMatchObject({ status: 'cancelled' });

    expect((await post(API_ROUTES.admin.jobRetry(424242), admin.cookie)).statusCode).toBe(404);
    expect((await post(API_ROUTES.admin.jobCancel(424242), admin.cookie)).json().error.code).toBe('not_found');
    expect((await post('/api/admin/jobs/abc/retry', admin.cookie)).statusCode).toBe(400);
  });
});
