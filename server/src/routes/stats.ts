import type { FastifyPluginAsync } from 'fastify';

/**
 * Stats routes — PLAN §6 "Stats" (every endpoint takes the ProfileFilters query), §4 player_games.
 *
 * Endpoints (request/response types in @outpost/shared/api):
 *   - GET /api/profiles/:slug/overview (OverviewStats)
 *   - GET /api/profiles/:slug/games (GamesQuery → GamesPage, pageSize 20)
 *   - GET /api/profiles/:slug/games.pgn (streamed application/x-chess-pgn, max 10,000 games, names normalised)
 *   - GET /api/profiles/:slug/openings (OpeningsQuery → OpeningsResponse)
 *   - GET /api/profiles/:slug/opponents (OpponentsQuery → OpponentsPage)
 *   - GET /api/profiles/:slug/behaviour (BehaviourStats)
 *   - GET /api/profiles/:slug/worldmap (WorldMapStats)
 *   - GET /api/profiles/:slug/activity (ActivityQuery → ActivityStats)
 *   - GET /api/profiles/:slug/rating (RatingQuery → RatingStats)
 *
 * Use { preHandler: requireViewer } plus the profile visibility check; parse filters with parseFiltersQuery (src/http/validate.ts). Queries live in src/stats/.
 *
 * TODO(stats): implement. Keep this file thin: validate with src/http/validate.ts, check access
 * with the preHandlers in src/auth/session.ts, call into the module, return contract types, and
 * throw HttpError (src/http/errors.ts) for failures. Build paths from API_ROUTES (pass ':param'
 * placeholders, e.g. API_ROUTES.profile(':slug')).
 */
const statsRoutes: FastifyPluginAsync = async _app => {
  // TODO(stats)
};

export default statsRoutes;
