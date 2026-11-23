import type { FastifyPluginAsync } from 'fastify';

/**
 * Jobs routes — PLAN §6 (jobs endpoints), §7 (job queue, lanes, backoff, scheduler).
 *
 * Endpoints (request/response types in @outpost/shared/api):
 *   - GET /api/jobs/mine (MyJobsResponse)
 *   - GET /api/admin/jobs (AdminJobsQuery → AdminJobsPage)
 *   - POST /api/admin/jobs/:id/retry
 *   - POST /api/admin/jobs/:id/cancel
 *
 * Start the per-lane workers and the daily auto-refresh scheduler from this plugin with app.addHook('onReady', ...) and stop them in app.addHook('onClose', ...), so main.ts never changes. Queue logic lives in src/jobs/.
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
