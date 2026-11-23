import type { FastifyPluginAsync } from 'fastify';

/**
 * Databases routes — PLAN §6 "Databases, files, reference, broadcasts and prep", §5 custom PGN databases, §4 databases/games.
 *
 * Endpoints (request/response types in @outpost/shared/api):
 *   - GET/POST /api/databases (DatabasesResponse / CreateDatabaseRequest → DatabaseInfo)
 *   - GET/PATCH/DELETE /api/databases/:id (DatabaseInfo / UpdateDatabaseRequest → DatabaseInfo / OkResponse)
 *   - POST /api/databases/:id/import (multipart .pgn up to 50 MB, or ImportPgnRequest JSON → ImportResponse; becomes a job)
 *   - GET /api/databases/:id/games (DbGamesQuery → DbGamesPage)
 *   - GET /api/databases/:id/export.pgn (streamed)
 *   - DELETE /api/databases/:id/games/:gameId (→ OkResponse)
 *
 * Duplicate key convention for games.origin_id is documented in 001_init.sql.
 *
 * Shared code: imports enqueue 'pgnImport' with enqueueJob (src/jobs/) and register its handler
 * here with registerJobHandler; the handler streams parsePgnGames → pgnToNormalizedGame →
 * insertGame (src/chess/). Access: loadDatabaseForViewer (src/profiles/access.ts). Game lists:
 * DB_GAME_ROW_COLUMNS + toDbGameRow (src/stats/gameRows.ts).
 *
 * TODO(profiles): implement. Keep this file thin: validate with src/http/validate.ts, check access
 * with the preHandlers in src/auth/session.ts, call into the module, return contract types, and
 * throw HttpError (src/http/errors.ts) for failures. Build paths from API_ROUTES (pass ':param'
 * placeholders, e.g. API_ROUTES.profile(':slug')).
 */
const databaseRoutes: FastifyPluginAsync = async _app => {
  // TODO(profiles)
};

export default databaseRoutes;
