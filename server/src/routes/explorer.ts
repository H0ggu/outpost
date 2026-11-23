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
 * Shared code to reuse (don't re-implement): playerGamesWhere + GAME_ROW_SELECT/toGameRow +
 * DB_GAME_ROW_COLUMNS/toDbGameRow (src/stats/), loadProfileForViewer / loadDatabaseForViewer
 * (src/profiles/access.ts), openingAt + getOpeningBook and posKeyAfterLine (src/chess/), and
 * app.upstream for every proxied call (src/http/upstream.ts; map failures with upstreamHttpError).
 *
 * Lila quirks to respect:
 *   - /api/tablebase/:variant stays **unauthenticated** (no requireViewer): lila's tablebase XHR
 *     uses `credentials: 'omit'`, so it never carries the session cookie, and it only proxies
 *     public data. Rate-limit it per IP instead.
 *   - Query schemas must ignore unknown keys (zod objects strip by default — never `.strict()`):
 *     lila sends extras such as `source=analysis` and `variant`.
 *   - The player explorer counts each game at most once per position (a game that repeats a
 *     position has several `positions` rows with the same pos_key): use the first occurrence.
 *   - Lila's own `speeds`/`modes`/`since`/`until` are ANDed with the `/f/:filters/` filters
 *     (player explorer and /api/explorer/games). Read them only through
 *     `explorerQueryRestrictions` (@outpost/shared/filters): lila always sends `speeds`, which has
 *     no `unknown`, so matching it literally would hide every PGN and reference game. ultraBullet
 *     is bullet; a full speed set and `modes=rated,casual` mean no restriction.
 *   - Lila needs an absolute `explorer.endpoint` (`explorerEndpoint` in @outpost/shared/api).
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
