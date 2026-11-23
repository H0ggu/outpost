import type { FastifyPluginAsync } from 'fastify';
import { API_ROUTES, type GameResponse } from '@outpost/shared/api';
import { requireViewer } from '../auth/session.ts';
import { idParams, parseParams } from '../http/validate.ts';
import { loadGameForViewer } from '../stats/index.ts';

/**
 * Games routes — PLAN §6 "Games, explorer and proxies" (GET /api/games/:id).
 *
 * Endpoints (request/response types in @outpost/shared/api):
 *   - GET /api/games/:id (GameResponse: GameDetail + PGN)
 *
 * Access: requireViewer, then the game must be in a database the viewer may see (reference
 * databases included) or have been played by a source of a profile the viewer may see; otherwise
 * 404 (src/stats/gameDetail.ts).
 */
const gameRoutes: FastifyPluginAsync = async app => {
  app.get(API_ROUTES.game(':id'), { preHandler: requireViewer }, async (req): Promise<GameResponse> => {
    const { id } = parseParams(idParams, req.params);
    return loadGameForViewer(app.db, id, req.user);
  });
};

export default gameRoutes;
