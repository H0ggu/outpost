import type { FastifyPluginAsync } from 'fastify';
import { API_ROUTES, type AdminJobsPage, type JobInfo, type MyJobsResponse } from '@outpost/shared/api';
import { z } from 'zod';
import { requireAdmin, requireUser } from '../auth/session.ts';
import { conflict, notFound } from '../http/errors.ts';
import { idParams, pageQuery, parseParams, parseQuery } from '../http/validate.ts';
import {
  cancelJob,
  JOB_KINDS,
  JOB_LANES,
  JOB_STATUSES,
  JobRunner,
  JobStateError,
  listAdminJobs,
  listMyJobs,
  retryJob,
  Scheduler,
} from '../jobs/index.ts';
import { registerSyncHandlers, sweepPendingLookups } from '../sync/index.ts';

/**
 * Jobs routes — PLAN §6 (jobs endpoints), §7 (job queue, lanes, backoff, scheduler).
 *
 * Endpoints (request/response types in @outpost/shared/api):
 *   - GET /api/jobs/mine (MyJobsResponse): queued and running jobs I started or that sync my
 *     profiles / import into my databases, with queue positions.
 *   - GET /api/admin/jobs (AdminJobsQuery → AdminJobsPage): filters status/kind/lane, paging
 *     (pageSize 50, max 200), counts per status.
 *   - POST /api/admin/jobs/:id/retry (→ JobInfo): re-queue a finished job, or run a job waiting
 *     for its backoff now; 409 while it runs.
 *   - POST /api/admin/jobs/:id/cancel (→ JobInfo): cancel a queued job or abort a running one;
 *     409 once it has finished.
 *
 * Registers the 'sync', 'geo' and 'rebuild' handlers (src/sync/). When `app.config.startWorkers`
 * is on, starts the lane workers and the scheduler (daily auto refresh, pruning, geo sweep) in
 * onReady and stops them in onClose — jobs still running then go back to the queue.
 */
const adminJobsQuery = pageQuery(50, 200).extend({
  status: z.enum(JOB_STATUSES).optional(),
  kind: z.enum(JOB_KINDS).optional(),
  lane: z.enum(JOB_LANES).optional(),
});

/** Periodic sweep for opponent lookups no job is handling. */
const GEO_SWEEP_EVERY_MS = 60 * 60_000;

const jobRoutes: FastifyPluginAsync = async app => {
  registerSyncHandlers();
  let runner: JobRunner | null = null;
  let scheduler: Scheduler | null = null;

  app.get(API_ROUTES.jobsMine, { preHandler: requireUser }, async (req): Promise<MyJobsResponse> => ({
    jobs: listMyJobs(app.db, req.user!.id),
  }));

  app.get(API_ROUTES.admin.jobs, { preHandler: requireAdmin }, async (req): Promise<AdminJobsPage> => {
    const q = parseQuery(adminJobsQuery, req.query);
    return listAdminJobs(app.db, q);
  });

  app.post(API_ROUTES.admin.jobRetry(':id'), { preHandler: requireAdmin }, async (req): Promise<JobInfo> => {
    const { id } = parseParams(idParams, req.params);
    let job: JobInfo | null;
    try {
      job = retryJob(app.db, id);
    } catch (e) {
      if (e instanceof JobStateError) throw conflict(e.message);
      throw e;
    }
    if (!job) throw notFound(`Job ${id} does not exist`);
    req.log.info({ jobId: id, newJobId: job.id }, 'admin retried a job');
    return job;
  });

  app.post(API_ROUTES.admin.jobCancel(':id'), { preHandler: requireAdmin }, async (req): Promise<JobInfo> => {
    const { id } = parseParams(idParams, req.params);
    let job: JobInfo | null;
    try {
      job = cancelJob(app.db, id, Date.now(), jobId => runner?.abortJob(jobId));
    } catch (e) {
      if (e instanceof JobStateError) throw conflict(e.message);
      throw e;
    }
    if (!job) throw notFound(`Job ${id} does not exist`);
    req.log.info({ jobId: id }, 'admin cancelled a job');
    return job;
  });

  if (!app.config.startWorkers) return;

  app.addHook('onReady', async () => {
    const log = app.log.child({ module: 'jobs' });
    runner = new JobRunner({ db: app.db, config: app.config, upstream: app.upstream, log });
    runner.start();
    scheduler = new Scheduler({
      db: app.db,
      config: app.config,
      log,
      tasks: [{ name: 'geoSweep', everyMs: GEO_SWEEP_EVERY_MS, run: now => void sweepPendingLookups(app.db, now) }],
    });
    scheduler.start();
  });

  app.addHook('onClose', async () => {
    scheduler?.stop();
    scheduler = null;
    await runner?.stop();
    runner = null;
  });
};

export default jobRoutes;
