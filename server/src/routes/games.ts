import type { FastifyPluginAsync } from 'fastify';

/**
 * Games routes — PLAN §6 "Games, explorer and proxies" (GET /api/games/:id).
 *
 * Endpoints (request/response types in @outpost/shared/api):
 *   - GET /api/games/:id (GameResponse: GameDetail + PGN)
 *
 * Access: the game must belong to a source of a profile the viewer may see, a database the viewer may see, or the reference DB
 * (loadProfileForViewer / loadDatabaseForViewer in src/profiles/access.ts).
 *
 * TODO(stats): implement. Keep this file thin: validate with src/http/validate.ts, check access
 * with the preHandlers in src/auth/session.ts, call into the module, return contract types, and
 * throw HttpError (src/http/errors.ts) for failures. Build paths from API_ROUTES (pass ':param'
 * placeholders, e.g. API_ROUTES.profile(':slug')).
 */
const gameRoutes: FastifyPluginAsync = async _app => {
  // TODO(stats)
};

export default gameRoutes;
