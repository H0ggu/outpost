import type { FastifyPluginAsync } from 'fastify';

/**
 * Reference database routes — PLAN §5 (Ultra/Masters DB, FIDE player pages), §6 (reference endpoints), research lichess-api.md §5.
 *
 * Endpoints (request/response types in @outpost/shared/api):
 *   - GET /api/reference (ReferenceInfo)
 *   - GET /api/reference/players?q= (ReferencePlayersResponse)
 *   - POST /api/admin/reference/broadcast-months (BroadcastMonthsRequest → ImportJobsResponse; requireAdmin)
 *   - POST /api/admin/reference/import (multipart PGN streamed to disk up to 2 GB, or ReferenceImportRequest {url}; requireAdmin)
 *
 * Imports run as jobs on the 'local' lane; zstd via node:zlib createZstdDecompress. Attribution: CC BY-SA 4.0 for Lichess broadcast data.
 *
 * Shared code: enqueue with enqueueJob and register the 'referenceImport', 'broadcastMonth' and
 * 'broadcastRound' handlers here with registerJobHandler (src/jobs/); parse with parsePgnGames /
 * pgnToNormalizedGame and store with insertGame (src/chess/); download through ctx.upstream.
 * searchReferencePlayers (src/reference/index.ts) is also called by the unified search. Any
 * scheduled auto-import must start only when app.config.startWorkers.
 *
 * TODO(reference): implement. Keep this file thin: validate with src/http/validate.ts, check access
 * with the preHandlers in src/auth/session.ts, call into the module, return contract types, and
 * throw HttpError (src/http/errors.ts) for failures. Build paths from API_ROUTES (pass ':param'
 * placeholders, e.g. API_ROUTES.profile(':slug')).
 */
const referenceRoutes: FastifyPluginAsync = async _app => {
  // TODO(reference)
};

export default referenceRoutes;
