import type { FastifyPluginAsync } from 'fastify';
import { API_ROUTES, type OkResponse, type PrepListResponse, type PrepReport, type PrepSet } from '@outpost/shared/api';
import { requireUser } from '../auth/session.ts';
import { idParams, parseBody, parseFiltersQuery, parseParams, parseQuery } from '../http/validate.ts';
import {
  createPrep,
  createPrepSchema,
  deletePrep,
  getPrep,
  listPrep,
  prepReport,
  prepReportParamsSchema,
  updatePrep,
  updatePrepSchema,
} from '../prep/index.ts';

/**
 * Prep routes — PLAN §5 (Tournament preparation), §6 (prep endpoints), §4 prep_sets/prep_opponents.
 *
 * Endpoints (request/response types in @outpost/shared/api):
 *   - GET/POST /api/prep (PrepListResponse / CreatePrepRequest → PrepSet)
 *   - GET/PUT/DELETE /api/prep/:id (PrepSet / UpdatePrepRequest → PrepSet / OkResponse)
 *   - GET /api/prep/:id/report (PrepReportQuery → PrepReport)
 *
 * Every route: { preHandler: requireUser }; a prep set is visible to its owner only (404 otherwise).
 * The report reuses src/stats/ (playerGamesWhere, GAME_ROW_SELECT/toGameRow) and
 * loadProfileForViewer for each opponent. Logic lives in src/prep/.
 */
const prepRoutes: FastifyPluginAsync = async app => {
  app.get(API_ROUTES.prep, { preHandler: requireUser }, async (req): Promise<PrepListResponse> => ({ sets: listPrep(app.db, req.user!) }));

  app.post(API_ROUTES.prep, { preHandler: requireUser }, async (req): Promise<PrepSet> => {
    const body = parseBody(createPrepSchema, req.body);
    return createPrep(app.db, req.user!, body);
  });

  app.get(API_ROUTES.prepSet(':id'), { preHandler: requireUser }, async (req): Promise<PrepSet> => {
    const { id } = parseParams(idParams, req.params);
    return getPrep(app.db, req.user!, id);
  });

  app.put(API_ROUTES.prepSet(':id'), { preHandler: requireUser }, async (req): Promise<PrepSet> => {
    const { id } = parseParams(idParams, req.params);
    const patch = parseBody(updatePrepSchema, req.body);
    return updatePrep(app.db, req.user!, id, patch);
  });

  app.delete(API_ROUTES.prepSet(':id'), { preHandler: requireUser }, async (req): Promise<OkResponse> => {
    const { id } = parseParams(idParams, req.params);
    deletePrep(app.db, req.user!, id);
    return { ok: true };
  });

  app.get(API_ROUTES.prepReport(':id'), { preHandler: requireUser }, async (req): Promise<PrepReport> => {
    const { id } = parseParams(idParams, req.params);
    const filters = parseFiltersQuery(req.query);
    const params = parseQuery(prepReportParamsSchema, req.query);
    return await prepReport(app.db, app.config, req.user!, id, filters, params);
  });
};

export default prepRoutes;
