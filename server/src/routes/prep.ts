import type { FastifyPluginAsync } from 'fastify';

/**
 * Prep routes — PLAN §5 (Tournament preparation), §6 (prep endpoints), §4 prep_sets/prep_opponents.
 *
 * Endpoints (request/response types in @outpost/shared/api):
 *   - GET/POST /api/prep (PrepListResponse / CreatePrepRequest → PrepSet)
 *   - GET/PUT/DELETE /api/prep/:id (PrepSet / UpdatePrepRequest)
 *   - GET /api/prep/:id/report (ProfileFilters + tz → PrepReport)
 *
 * Every route: { preHandler: requireUser }. Reuse src/stats/ queries for the report.
 *
 * TODO(profiles): implement. Keep this file thin: validate with src/http/validate.ts, check access
 * with the preHandlers in src/auth/session.ts, call into the module, return contract types, and
 * throw HttpError (src/http/errors.ts) for failures. Build paths from API_ROUTES (pass ':param'
 * placeholders, e.g. API_ROUTES.profile(':slug')).
 */
const prepRoutes: FastifyPluginAsync = async _app => {
  // TODO(profiles)
};

export default prepRoutes;
