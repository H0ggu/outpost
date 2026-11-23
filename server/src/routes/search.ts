import type { FastifyPluginAsync } from 'fastify';
import { API_ROUTES, type SearchResults } from '@outpost/shared/api';
import { z } from 'zod';
import { requireViewer } from '../auth/session.ts';
import { parseQuery } from '../http/validate.ts';
import { MAX_QUERY_LENGTH, MIN_QUERY_LENGTH, search, SearchCache } from '../search/index.ts';

/**
 * Search routes — PLAN §6 "Search and profiles" (GET /api/search), §5 unified search.
 *
 * Endpoints (request/response types in @outpost/shared/api):
 *   - GET /api/search?q= (SearchResults: local profiles, Lichess autocomplete, Chess.com exact-username check, known usernames, reference players)
 *
 * requireViewer; throttled per client IP (each query can reach Lichess and Chess.com); upstream calls
 * have a short deadline (body included) and stop when the client closes the request. Logic in src/search/.
 */

/** Searches per IP per minute (the web app debounces typing). */
export const SEARCH_RATE_LIMIT = { max: 60, timeWindow: 60_000 } as const;

const searchQuery = z.object({
  q: z
    .string()
    .trim()
    .min(MIN_QUERY_LENGTH, `type at least ${MIN_QUERY_LENGTH} characters`)
    .max(MAX_QUERY_LENGTH)
    .refine(s => !/[\u0000-\u001f\u007f]/.test(s), 'control characters are not allowed'),
});

const searchRoutes: FastifyPluginAsync = async app => {
  const cache = new SearchCache();

  app.get(
    API_ROUTES.search,
    { preHandler: requireViewer, config: { rateLimit: SEARCH_RATE_LIMIT } },
    async (req, reply): Promise<SearchResults> => {
      const { q } = parseQuery(searchQuery, req.query);
      // Stop the upstream calls when the client goes away (typing ahead cancels the previous search).
      const gone = new AbortController();
      const onClose = (): void => {
        if (!reply.raw.writableFinished) gone.abort();
      };
      reply.raw.once('close', onClose);
      try {
        return await search({ db: app.db, upstream: app.upstream, cache, signal: gone.signal }, q, req.user);
      } finally {
        reply.raw.off('close', onClose);
      }
    },
  );
};

export default searchRoutes;
