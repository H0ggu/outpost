import { Readable } from 'node:stream';
import type { FastifyPluginAsync } from 'fastify';
import {
  API_ROUTES,
  slugify,
  type DatabaseInfo,
  type DatabasesResponse,
  type DbGamesPage,
  type ImportResponse,
  type OkResponse,
} from '@outpost/shared/api';
import { z } from 'zod';
import { requireUser, requireViewer } from '../auth/session.ts';
import {
  createDatabase,
  createDatabaseSchema,
  databaseGames,
  dbGamesQuerySchema,
  databaseInfo,
  deleteDatabase,
  deleteDatabaseGame,
  enqueuePgnImport,
  exportDatabasePgn,
  importPgnSchema,
  listDatabases,
  MAX_PGN_BYTES,
  requireDatabaseEditor,
  runPgnImport,
  saveUploadStream,
  saveUploadText,
  sweepUploads,
  updateDatabase,
  updateDatabaseSchema,
} from '../databases/index.ts';
import { badRequest, HttpError } from '../http/errors.ts';
import { idParams, parseBody, parseParams, parseQuery, zId } from '../http/validate.ts';
import { registerJobHandler } from '../jobs/index.ts';
import { loadDatabaseForViewer } from '../profiles/access.ts';

/**
 * Databases routes — PLAN §6 "Databases, files, reference, broadcasts and prep", §5 custom PGN databases, §4 databases/games.
 *
 * Endpoints (request/response types in @outpost/shared/api):
 *   - GET/POST /api/databases (DatabasesResponse / CreateDatabaseRequest → DatabaseInfo)
 *   - GET/PATCH/DELETE /api/databases/:id (DatabaseInfo / UpdateDatabaseRequest → DatabaseInfo / OkResponse)
 *   - POST /api/databases/:id/import (multipart .pgn up to 50 MB, or ImportPgnRequest JSON → ImportResponse; becomes a job)
 *   - GET /api/databases/:id/games (DbGamesQuery → DbGamesPage)
 *   - GET /api/databases/:id/export.pgn (streamed)
 *   - DELETE /api/databases/:id/games/:gameId (→ OkResponse)
 *
 * Reads: requireViewer + loadDatabaseForViewer (404 for private databases of others). Mutations:
 * requireUser, then owner or admin (403). Imports run as the 'pgnImport' job registered here
 * (src/databases/import.ts). Logic lives in src/databases/.
 */

/** Imports per IP per minute. */
export const IMPORT_RATE_LIMIT = { max: 20, timeWindow: 60_000 } as const;

const gameParams = z.object({ id: zId, gameId: zId });
const PGN_FILE_RE = /\.(pgn|txt)$/i;
const PGN_MIME_RE = /^(application\/(x-chess-pgn|vnd\.chess-pgn|octet-stream)|text\/plain)$/i;

const databaseRoutes: FastifyPluginAsync = async app => {
  registerJobHandler('pgnImport', runPgnImport);
  app.addHook('onReady', async () => {
    await sweepUploads(app.db, app.config).catch(err => app.log.warn({ err }, 'could not sweep old PGN uploads'));
  });

  app.get(API_ROUTES.databases, { preHandler: requireViewer }, async (req): Promise<DatabasesResponse> => ({
    databases: listDatabases(app.db, req.user),
  }));

  app.post(API_ROUTES.databases, { preHandler: requireUser }, async (req): Promise<DatabaseInfo> => {
    const body = parseBody(createDatabaseSchema, req.body);
    const id = createDatabase(app.db, req.user!, body);
    return databaseInfo(app.db, loadDatabaseForViewer(app.db, id, req.user), req.user);
  });

  app.get(API_ROUTES.database(':id'), { preHandler: requireViewer }, async (req): Promise<DatabaseInfo> => {
    const { id } = parseParams(idParams, req.params);
    return databaseInfo(app.db, loadDatabaseForViewer(app.db, id, req.user), req.user);
  });

  app.patch(API_ROUTES.database(':id'), { preHandler: requireUser }, async (req): Promise<DatabaseInfo> => {
    const { id } = parseParams(idParams, req.params);
    const patch = parseBody(updateDatabaseSchema, req.body);
    const database = loadDatabaseForViewer(app.db, id, req.user);
    updateDatabase(app.db, database, patch);
    return databaseInfo(app.db, database, req.user);
  });

  app.delete(API_ROUTES.database(':id'), { preHandler: requireUser }, async (req): Promise<OkResponse> => {
    const { id } = parseParams(idParams, req.params);
    await deleteDatabase(app.db, app.config, loadDatabaseForViewer(app.db, id, req.user));
    return { ok: true };
  });

  app.post(
    API_ROUTES.databaseImport(':id'),
    {
      preHandler: requireUser,
      // Pasted PGN as JSON: 50 MB of PGN plus JSON escaping.
      bodyLimit: MAX_PGN_BYTES + 10 * 1024 * 1024,
      config: { rateLimit: IMPORT_RATE_LIMIT },
    },
    async (req): Promise<ImportResponse> => {
      const { id } = parseParams(idParams, req.params);
      const database = loadDatabaseForViewer(app.db, id, req.user);
      requireDatabaseEditor(database);
      if (database.kind !== 'games') throw badRequest('Reference databases are imported from the admin reference page');

      let file: string;
      let originalName: string | null = null;
      if (req.isMultipart()) {
        const part = await req.file();
        if (!part || part.fieldname !== 'file') throw badRequest('Send the PGN file in the multipart field "file"');
        if (!PGN_FILE_RE.test(part.filename) && !PGN_MIME_RE.test(part.mimetype)) {
          part.file.resume();
          throw new HttpError(415, 'unsupported_media_type', 'Upload a .pgn file');
        }
        originalName = part.filename.slice(0, 200) || null;
        file = await saveUploadStream(app.config, part.file);
      } else {
        const { pgn } = parseBody(importPgnSchema, req.body);
        if (Buffer.byteLength(pgn, 'utf8') > MAX_PGN_BYTES) {
          throw new HttpError(413, 'payload_too_large', `PGN is limited to ${MAX_PGN_BYTES / 1024 / 1024} MB`);
        }
        file = await saveUploadText(app.config, pgn);
      }
      return enqueuePgnImport(app.db, database.id, file, originalName, req.user!.id);
    },
  );

  app.get(API_ROUTES.databaseGames(':id'), { preHandler: requireViewer }, async (req): Promise<DbGamesPage> => {
    const { id } = parseParams(idParams, req.params);
    const query = parseQuery(dbGamesQuerySchema, req.query);
    return databaseGames(app.db, loadDatabaseForViewer(app.db, id, req.user), query);
  });

  app.get(API_ROUTES.databaseExport(':id'), { preHandler: requireViewer }, async (req, reply) => {
    const { id } = parseParams(idParams, req.params);
    const database = loadDatabaseForViewer(app.db, id, req.user);
    const filename = `${slugify(database.name)}.pgn`;
    return reply
      .type('application/x-chess-pgn; charset=utf-8')
      .header('content-disposition', `attachment; filename="${filename}"`)
      .header('cache-control', 'no-store')
      .send(Readable.from(exportDatabasePgn(app.db, database.id)));
  });

  app.delete(API_ROUTES.databaseGame(':id', ':gameId'), { preHandler: requireUser }, async (req): Promise<OkResponse> => {
    const { id, gameId } = parseParams(gameParams, req.params);
    deleteDatabaseGame(app.db, loadDatabaseForViewer(app.db, id, req.user), gameId);
    return { ok: true };
  });
};

export default databaseRoutes;
