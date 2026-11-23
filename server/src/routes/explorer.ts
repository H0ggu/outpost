import type { FastifyPluginAsync } from 'fastify';

/**
 * Explorer and proxies routes — PLAN §6 "Games, explorer and proxies", §8.3 (lila explorer endpoint), research lichess-api.md §3.
 *
 * Endpoints (request/response types in @outpost/shared/api):
 *   - GET /api/explorer/masters, /api/explorer/masters/pgn/:id (proxy explorer.lichess.org, cached 3 h; local reference DB when mastersSource is set)
 *   - GET /api/explorer/lichess (proxy with token, cached, max 20 req/min with a queue)
 *   - GET /api/explorer/player (Lichess-compatible NDJSON, one final line: ExplorerPlayerResponse)
 *   - GET /api/explorer/f/:filters/{player,masters,lichess,reference} (lila resolves './<db>' against the filtered base, so every explorer db must also answer under /f/:filters/; decode with decodeFiltersSegment)
 *   - GET /api/explorer/reference (ExplorerMastersResponse shape from the local reference DB)
 *   - GET /api/explorer/games (ExplorerGamesQuery → ExplorerGamesPage)
 *   - GET /api/tablebase/:variant (proxy tablebase.lichess.ovh, cached)
 *   - GET /api/cloud-eval (proxy lichess.org/api/cloud-eval)
 *
 * Fastify's maxParamLength is raised in app.ts so long filter segments fit. Position keys: src/chess/posKey.ts.
 *
 * TODO(explorer): implement. Keep this file thin: validate with src/http/validate.ts, check access
 * with the preHandlers in src/auth/session.ts, call into the module, return contract types, and
 * throw HttpError (src/http/errors.ts) for failures. Build paths from API_ROUTES (pass ':param'
 * placeholders, e.g. API_ROUTES.profile(':slug')).
 */
const explorerRoutes: FastifyPluginAsync = async _app => {
  // TODO(explorer)
};

export default explorerRoutes;
