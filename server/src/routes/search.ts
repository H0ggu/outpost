import type { FastifyPluginAsync } from 'fastify';

/**
 * Search routes — PLAN §6 "Search and profiles" (GET /api/search), §5 unified search.
 *
 * Endpoints (request/response types in @outpost/shared/api):
 *   - GET /api/search?q= (SearchResults: local profiles, Lichess autocomplete, Chess.com exact-username check, known usernames, reference players)
 *
 * Use { preHandler: requireViewer }. Upstream calls go through the server only (the Lichess token never reaches the browser).
 *
 * TODO(profiles): implement. Keep this file thin: validate with src/http/validate.ts, check access
 * with the preHandlers in src/auth/session.ts, call into the module, return contract types, and
 * throw HttpError (src/http/errors.ts) for failures. Build paths from API_ROUTES (pass ':param'
 * placeholders, e.g. API_ROUTES.profile(':slug')).
 */
const searchRoutes: FastifyPluginAsync = async _app => {
  // TODO(profiles)
};

export default searchRoutes;
