import type { FastifyPluginAsync } from 'fastify';
import {
  API_ROUTES,
  type BroadcastMonthsRequest,
  type ImportJobsResponse,
  type ImportResponse,
  type ReferenceImportRequest,
  type ReferenceInfo,
  type ReferencePlayersResponse,
} from '@outpost/shared/api';
import { z } from 'zod';
import { requireAdmin, requireViewer } from '../auth/session.ts';
import { badRequest } from '../http/errors.ts';
import { parseBody, parseQuery, zId } from '../http/validate.ts';
import { registerJobHandler } from '../jobs/index.ts';
import { startBroadcastAutoImport } from '../reference/autoImport.ts';
import { MAX_LICENCE_LENGTH, MAX_NAME_LENGTH } from '../reference/databases.ts';
import { REFERENCE_JOB_HANDLERS } from '../reference/jobs.ts';
import { BroadcastMonthCatalog } from '../reference/months.ts';
import { PLAYER_SEARCH_DEFAULT_LIMIT, PLAYER_SEARCH_MAX_LIMIT, PLAYER_SEARCH_MAX_QUERY, searchReferencePlayers } from '../reference/players.ts';
import { enqueueBroadcastMonths, enqueueReferenceImport, referenceInfo } from '../reference/service.ts';
import { receiveReferenceUpload, removeUpload, sweepReferenceUploads } from '../reference/upload.ts';
import { MAX_IMPORT_URL_LENGTH } from '../reference/urls.ts';

/**
 * Reference database routes — PLAN §5 (Ultra/Masters DB, FIDE player pages), §6 (reference endpoints), research lichess-api.md §5.
 *
 * Endpoints (request/response types in @outpost/shared/api):
 *   - GET /api/reference (ReferenceInfo; requireViewer)
 *   - GET /api/reference/players?q=&limit= (ReferencePlayersResponse; requireViewer)
 *   - POST /api/admin/reference/broadcast-months (BroadcastMonthsRequest → ImportJobsResponse; requireAdmin)
 *   - POST /api/admin/reference/import (multipart `file` streamed to disk up to 2 GB with the
 *     ReferenceImportRequest fields, or ReferenceImportRequest JSON with `url`; → ImportResponse; requireAdmin)
 *
 * Imports run as jobs: 'broadcastMonth' and 'referenceImport' on the local lane, 'broadcastRound'
 * on the lichess lane (handlers in src/reference/jobs.ts, registered here). Attribution: CC BY-SA
 * 4.0 for Lichess broadcast data. Background work started here: the upload sweeper (always; local
 * files only) and the broadcast auto-import timer (only when app.config.startWorkers; each tick
 * also checks the `broadcastAutoImport` setting and the token).
 */

/** Empty form fields count as absent. */
const optionalText = (max: number) =>
  z.preprocess(v => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().trim().min(1).max(max).optional());

const importRequestSchema = z
  .object({
    url: optionalText(MAX_IMPORT_URL_LENGTH),
    databaseId: z.preprocess(v => (v === '' || v === null ? undefined : v), zId.optional()),
    databaseName: optionalText(MAX_NAME_LENGTH),
    sourceLabel: optionalText(MAX_NAME_LENGTH),
    licence: optionalText(MAX_LICENCE_LENGTH),
  })
  .strict();

const broadcastMonthsSchema = z
  .object({
    months: z.array(z.string().max(16)).min(1).max(240),
    databaseId: zId.optional(),
  })
  .strict();

const playersQuery = z.object({
  q: z.string().max(PLAYER_SEARCH_MAX_QUERY * 2).default(''),
  limit: z.coerce.number().int().min(1).max(PLAYER_SEARCH_MAX_LIMIT).default(PLAYER_SEARCH_DEFAULT_LIMIT),
});

/** Strips undefined values (exactOptionalPropertyTypes-friendly request objects). */
const defined = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

const referenceRoutes: FastifyPluginAsync = async app => {
  registerJobHandler('broadcastMonth', REFERENCE_JOB_HANDLERS.broadcastMonth);
  registerJobHandler('referenceImport', REFERENCE_JOB_HANDLERS.referenceImport);
  registerJobHandler('broadcastRound', REFERENCE_JOB_HANDLERS.broadcastRound);

  const catalog = new BroadcastMonthCatalog(app.upstream);

  app.get(API_ROUTES.reference, { preHandler: requireViewer }, async (req): Promise<ReferenceInfo> =>
    referenceInfo(app.db, catalog, req.user),
  );

  app.get(
    API_ROUTES.referencePlayers,
    { preHandler: requireViewer, config: { rateLimit: { max: 300, timeWindow: '1 minute' } } },
    async (req): Promise<ReferencePlayersResponse> => {
      const { q, limit } = parseQuery(playersQuery, req.query);
      return { players: searchReferencePlayers(app.db, q, { limit, viewer: req.user }) };
    },
  );

  app.post(API_ROUTES.admin.referenceBroadcastMonths, { preHandler: requireAdmin }, async (req): Promise<ImportJobsResponse> => {
    const body = parseBody(broadcastMonthsSchema, req.body);
    return enqueueBroadcastMonths(app.db, defined(body) as BroadcastMonthsRequest, req.user!);
  });

  app.post(API_ROUTES.admin.referenceImport, { preHandler: requireAdmin }, async (req): Promise<ImportResponse> => {
    if (!req.isMultipart()) {
      const body = defined(parseBody(importRequestSchema, req.body ?? {})) as ReferenceImportRequest;
      return enqueueReferenceImport(app.db, app.config, body, null, req.user!);
    }
    const upload = await receiveReferenceUpload(req, app.config);
    try {
      if (!upload.file) throw badRequest('Send the PGN in the multipart field "file" (or post JSON with a url)');
      const body = defined(parseBody(importRequestSchema, upload.fields)) as ReferenceImportRequest;
      if (body.url) throw badRequest('Send either a file or a url, not both');
      return enqueueReferenceImport(app.db, app.config, body, { file: upload.file }, req.user!);
    } catch (e) {
      if (upload.file) await removeUpload(app.config, upload.file);
      throw e;
    }
  });

  // Uploads left behind by cancelled or crashed imports (local files only, no upstream calls).
  let sweeper: NodeJS.Timeout | null = null;
  let sweeping: Promise<unknown> = Promise.resolve();
  let stopAutoImport: (() => Promise<void>) | null = null;
  app.addHook('onReady', async () => {
    const sweep = (): void => {
      sweeping = sweepReferenceUploads(app.db, app.config).catch(err => app.log.warn({ err }, 'reference upload sweep failed'));
    };
    sweep();
    sweeper = setInterval(sweep, SWEEP_INTERVAL_MS);
    sweeper.unref();
    if (app.config.startWorkers) {
      stopAutoImport = startBroadcastAutoImport({ db: app.db, config: app.config, upstream: app.upstream, log: app.log });
    }
  });
  app.addHook('onClose', async () => {
    if (sweeper) clearInterval(sweeper);
    await stopAutoImport?.();
    await sweeping; // the database closes after the app
  });
};

export default referenceRoutes;
