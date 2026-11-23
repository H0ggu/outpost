import type { FastifyPluginAsync } from 'fastify';

/**
 * Assets routes — PLAN §6 (GET /assets/lifat/nnue/:name), §8 (stockfish-web).
 *
 * Endpoints (request/response types in @outpost/shared/api):
 *   - GET /assets/lifat/nnue/:name — download once from tests.stockfishchess.org/api/nn/:name into config.nnueDir and serve from there; name allow-list ^nn-[0-9a-f]{12}\.nnue$
 *
 * Serve with long-lived caching; the security headers (COEP) are added globally.
 *
 * TODO(explorer): implement. Keep this file thin: validate with src/http/validate.ts, check access
 * with the preHandlers in src/auth/session.ts, call into the module, return contract types, and
 * throw HttpError (src/http/errors.ts) for failures. Build paths from API_ROUTES (pass ':param'
 * placeholders, e.g. API_ROUTES.profile(':slug')).
 */
const assetRoutes: FastifyPluginAsync = async _app => {
  // TODO(explorer)
};

export default assetRoutes;
