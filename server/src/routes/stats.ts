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
 * Use { preHandler: requireViewer } plus loadProfileForViewer (src/profiles/access.ts: 404 for private profiles of
 * others, visible source ids); parse filters with parseFiltersQuery (src/http/validate.ts) and turn them into SQL with
 * playerGamesWhere (src/stats/filterSql.ts — already implemented; it is shared with the explorer and prep, so change
 * semantics there, not per endpoint). Game lists: GAME_ROW_SELECT + toGameRow (src/stats/gameRows.ts). Queries live in src/stats/.
 * Endpoint params (OpeningsParams, OpponentsParams, ActivityParams) never reuse filter keys; parse them with parseQuery
 * on a schema that ignores unknown keys.
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
