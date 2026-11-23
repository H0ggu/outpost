import type { FastifyPluginAsync } from 'fastify';
import { API_ROUTES, type BroadcastRound, type BroadcastsResponse, type BroadcastTour } from '@outpost/shared/api';
import { z } from 'zod';
import { requireViewer } from '../auth/session.ts';
import { BROADCAST_ID_RE, BroadcastService } from '../broadcasts/index.ts';
import { upstreamHttpError } from '../http/upstream.ts';
import { parseParams } from '../http/validate.ts';

/**
 * Live broadcasts routes — PLAN §5 (Live broadcasts), §6, research lichess-api.md §4.
 *
 * Endpoints (request/response types in @outpost/shared/api), all `requireViewer`:
 *   - GET /api/broadcasts (BroadcastsResponse from Lichess's top list: active, upcoming, recent; server cache 60 s)
 *   - GET /api/broadcasts/tour/:tourId (BroadcastTour; cache 30 s)
 *   - GET /api/broadcasts/round/:roundId (BroadcastRound; server cache 5 s, clients poll every 10 s)
 *   - GET /api/broadcasts/round/:roundId.pgn (application/x-chess-pgn; cache 10 s)
 *   - GET /api/broadcasts/round/:roundId/game/:gameId.pgn (one game of that PGN, cut on the server)
 *
 * All upstream calls carry the Lichess token (PR #21283): without one they fail with 503
 * `upstream_unavailable` (`details.reason: 'no_token'`); an unknown tour or round is 404 (and
 * remembered for a minute). Cache misses share one instance-wide budget of upstream calls per
 * minute (src/broadcasts/service.ts): past it, 503 `upstream_unavailable` (`reason: 'budget'`).
 */

const broadcastId = (name: string) => z.string().regex(BROADCAST_ID_RE, `${name} must be 8 letters or digits`);
const tourParams = z.object({ tourId: broadcastId('tourId') });
const roundParams = z.object({ roundId: broadcastId('roundId') });
const gameParams = z.object({ roundId: broadcastId('roundId'), gameId: broadcastId('gameId') });

/** Upstream failures → 502/503 API errors (404s are already HttpErrors). */
async function proxied<T>(load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (e) {
    throw upstreamHttpError(e);
  }
}

const broadcastRoutes: FastifyPluginAsync = async app => {
  const service = new BroadcastService({ upstream: app.upstream, db: app.db });
  const limited = { rateLimit: { max: 120, timeWindow: '1 minute' } };

  app.get(API_ROUTES.broadcasts, { preHandler: requireViewer, config: limited }, async (): Promise<BroadcastsResponse> =>
    proxied(() => service.list()),
  );

  app.get(API_ROUTES.broadcastTour(':tourId'), { preHandler: requireViewer, config: limited }, async (req): Promise<BroadcastTour> => {
    const { tourId } = parseParams(tourParams, req.params);
    return proxied(() => service.tour(tourId));
  });

  app.get(API_ROUTES.broadcastRoundPgn(':roundId'), { preHandler: requireViewer, config: limited }, async (req, reply) => {
    const { roundId } = parseParams(roundParams, req.params);
    const pgn = await proxied(() => service.roundPgn(roundId));
    return reply
      .header('content-type', 'application/x-chess-pgn; charset=utf-8')
      .header('content-disposition', `attachment; filename="broadcast-${roundId}.pgn"`)
      .send(pgn);
  });

  app.get(API_ROUTES.broadcastGamePgn(':roundId', ':gameId'), { preHandler: requireViewer, config: limited }, async (req, reply) => {
    const { roundId, gameId } = parseParams(gameParams, req.params);
    const pgn = await proxied(() => service.gamePgn(roundId, gameId));
    return reply
      .header('content-type', 'application/x-chess-pgn; charset=utf-8')
      .header('content-disposition', `attachment; filename="broadcast-${roundId}-${gameId}.pgn"`)
      .send(pgn);
  });

  app.get(API_ROUTES.broadcastRound(':roundId'), { preHandler: requireViewer, config: limited }, async (req): Promise<BroadcastRound> => {
    const { roundId } = parseParams(roundParams, req.params);
    return proxied(() => service.round(roundId));
  });
};

export default broadcastRoutes;
