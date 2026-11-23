import type { FastifyPluginAsync } from 'fastify';

/**
 * Live broadcasts routes — PLAN §5 (Live broadcasts), §6, research lichess-api.md §4.
 *
 * Endpoints (request/response types in @outpost/shared/api):
 *   - GET /api/broadcasts (BroadcastsResponse)
 *   - GET /api/broadcasts/tour/:tourId (BroadcastTour)
 *   - GET /api/broadcasts/round/:roundId (BroadcastRound; server cache 5 s, clients poll every 10 s)
 *   - GET /api/broadcasts/round/:roundId.pgn (find-my-way accepts this next to :roundId)
 *
 * All upstream calls carry the Lichess token (PR #21283).
 *
 * TODO(reference): implement. Keep this file thin: validate with src/http/validate.ts, check access
 * with the preHandlers in src/auth/session.ts, call into the module, return contract types, and
 * throw HttpError (src/http/errors.ts) for failures. Build paths from API_ROUTES (pass ':param'
 * placeholders, e.g. API_ROUTES.profile(':slug')).
 */
const broadcastRoutes: FastifyPluginAsync = async _app => {
  // TODO(reference)
};

export default broadcastRoutes;
