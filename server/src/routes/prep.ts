import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { API_ROUTES, type Id, type OkResponse, type PrepListResponse, type PrepReport, type PrepSet } from '@outpost/shared/api';
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
import { perUserRateLimit } from '../profiles/rateLimit.ts';

/** Prep reports per user per minute (one report reads up to 50 opponents' games). */
export const PREP_REPORT_RATE_LIMIT = perUserRateLimit(20, 60_000);

/** Aborts when the client goes away before the report is sent. */
function clientSignal(reply: FastifyReply): AbortSignal {
  const c = new AbortController();
  reply.raw.once('close', () => {
    if (!reply.raw.writableFinished) c.abort();
  });
  return c.signal;
}

/**
 * Runs one user's reports one at a time: a later request waits for the earlier ones, so a user
 * never has several reports computing in parallel (each takes seconds over large opponents).
 */
function oneAtATimePerUser(): <T>(userId: Id, fn: () => Promise<T>) => Promise<T> {
  const tails = new Map<Id, Promise<unknown>>();
  return async (userId, fn) => {
    const run = (tails.get(userId) ?? Promise.resolve()).then(fn, fn);
    const tail = run.catch(() => undefined);
    tails.set(userId, tail);
    try {
      return await run;
    } finally {
      if (tails.get(userId) === tail) tails.delete(userId);
    }
  };
}

/**
 * Prep routes — PLAN §5 (Tournament preparation), §6 (prep endpoints), §4 prep_sets/prep_opponents.
 *
 * Endpoints (request/response types in @outpost/shared/api):
 *   - GET/POST /api/prep (PrepListResponse / CreatePrepRequest → PrepSet)
 *   - GET/PUT/DELETE /api/prep/:id (PrepSet / UpdatePrepRequest → PrepSet / OkResponse)
 *   - GET /api/prep/:id/report (PrepReportQuery → PrepReport)
 *
 * Every route: { preHandler: requireUser }; a prep set is visible to its owner only (404 otherwise).
 * Reports are throttled per user (PREP_REPORT_RATE_LIMIT), computed one at a time per user and
 * stopped when the client goes away.
 * The report reuses src/stats/ (playerGamesWhere, GAME_ROW_SELECT/toGameRow) and
 * loadProfileForViewer for each opponent. Logic lives in src/prep/.
 */
const prepRoutes: FastifyPluginAsync = async app => {
  const reportQueue = oneAtATimePerUser();
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

  app.get(
    API_ROUTES.prepReport(':id'),
    { preHandler: requireUser, config: { rateLimit: PREP_REPORT_RATE_LIMIT } },
    async (req, reply): Promise<PrepReport> => {
      const { id } = parseParams(idParams, req.params);
      const filters = parseFiltersQuery(req.query);
      const params = parseQuery(prepReportParamsSchema, req.query);
      const signal = clientSignal(reply);
      return await reportQueue(req.user!.id, () => prepReport(app.db, app.config, req.user!, id, filters, { ...params, signal }));
    },
  );
};

export default prepRoutes;
