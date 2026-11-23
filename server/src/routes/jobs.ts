import type { FastifyPluginAsync } from 'fastify';

/**
 * Jobs routes — PLAN §6 (jobs endpoints), §7 (job queue, lanes, backoff, scheduler).
 *
 * Endpoints (request/response types in @outpost/shared/api):
 *   - GET /api/jobs/mine (MyJobsResponse)
 *   - GET /api/admin/jobs (AdminJobsQuery → AdminJobsPage)
 *   - POST /api/admin/jobs/:id/retry (→ JobInfo)
 *   - POST /api/admin/jobs/:id/cancel (→ JobInfo)
 *
 * Start the per-lane workers and the daily auto-refresh scheduler from this plugin with app.addHook('onReady', ...) and stop them in app.addHook('onClose', ...), so main.ts never changes — **only when app.config.startWorkers** (false under NODE_ENV=test, so other modules' tests that enqueue jobs never call upstream). Queue logic lives in src/jobs/ (enqueueJob, toJobInfo, queuePosition are already the cross-module API); register the 'sync', 'geo' and 'rebuild' handlers here with registerJobHandler.
 *
 * Responses: retry and cancel return the updated JobInfo.
 *
 * TODO(jobs): implement. Keep this file thin: validate with src/http/validate.ts, check access
 * with the preHandlers in src/auth/session.ts, call into the module, return contract types, and
 * throw HttpError (src/http/errors.ts) for failures. Build paths from API_ROUTES (pass ':param'
 * placeholders, e.g. API_ROUTES.profile(':slug')).
 */
const jobRoutes: FastifyPluginAsync = async _app => {
  // TODO(jobs)
};

export default jobRoutes;
