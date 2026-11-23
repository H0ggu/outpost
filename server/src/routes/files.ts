import type { FastifyPluginAsync } from 'fastify';
import {
  API_ROUTES,
  type FileSearchResponse,
  type FilesResponse,
  type FoldersResponse,
  type OkResponse,
  type StudioFile,
} from '@outpost/shared/api';
import { requireUser } from '../auth/session.ts';
import {
  createFile,
  createFileSchema,
  deleteFile,
  fileSearchQuerySchema,
  filesQuerySchema,
  getFile,
  listFiles,
  listFolders,
  MAX_FILE_PGN,
  restoreFile,
  searchFiles,
  updateFile,
  updateFileSchema,
} from '../files/index.ts';
import { idParams, parseBody, parseParams, parseQuery } from '../http/validate.ts';
import { perUserRateLimit } from '../profiles/rateLimit.ts';

/**
 * Studio files routes — PLAN §6 (files, folders), §8.4 My Files, §4 files.
 *
 * Endpoints (request/response types in @outpost/shared/api):
 *   - GET /api/files?folder&trash=1 (FilesResponse)
 *   - POST /api/files (CreateFileRequest → StudioFile)
 *   - GET/PUT/DELETE /api/files/:id (StudioFile / UpdateFileRequest → StudioFile / OkResponse; DELETE soft-deletes into the
 *     recycle bin, and deleting a file that is already in the bin removes it for good)
 *   - POST /api/files/:id/restore (→ StudioFile)
 *   - GET /api/files/search?fen= (FileSearchResponse)
 *   - GET /api/folders (FoldersResponse)
 *
 * Every route: { preHandler: requireUser }; users only ever see their own files (404 otherwise).
 * Saves and searches are throttled per user; storage is limited per user (src/files/).
 * Fastify matches the static /api/files/search before /api/files/:id. Logic lives in src/files/.
 */

/** JSON bodies carry up to MAX_FILE_PGN characters of PGN (plus escaping). */
const FILE_BODY_LIMIT = MAX_FILE_PGN * 2 + 64 * 1024;

/** Saves (create / update) per user per minute: generous for Studio's autosave, bounds re-indexing work. */
export const FILE_SAVE_RATE_LIMIT = perUserRateLimit(120);
/** Position searches per user per minute (a search may (re)index changed files). */
export const FILE_SEARCH_RATE_LIMIT = perUserRateLimit(30);

const fileRoutes: FastifyPluginAsync = async app => {
  app.get(API_ROUTES.files, { preHandler: requireUser }, async (req): Promise<FilesResponse> => {
    const query = parseQuery(filesQuerySchema, req.query);
    return { files: listFiles(app.db, req.user!.id, query) };
  });

  app.post(API_ROUTES.files, { preHandler: requireUser, bodyLimit: FILE_BODY_LIMIT, config: { rateLimit: FILE_SAVE_RATE_LIMIT } }, async (req): Promise<StudioFile> => {
    const body = parseBody(createFileSchema, req.body);
    return createFile(app.db, req.user!.id, body);
  });

  app.get(API_ROUTES.filesSearch, { preHandler: requireUser, config: { rateLimit: FILE_SEARCH_RATE_LIMIT } }, async (req): Promise<FileSearchResponse> => {
    const { fen } = parseQuery(fileSearchQuerySchema, req.query);
    return searchFiles(app.db, req.user!.id, fen);
  });

  app.get(API_ROUTES.file(':id'), { preHandler: requireUser }, async (req): Promise<StudioFile> => {
    const { id } = parseParams(idParams, req.params);
    return getFile(app.db, req.user!.id, id);
  });

  app.put(API_ROUTES.file(':id'), { preHandler: requireUser, bodyLimit: FILE_BODY_LIMIT, config: { rateLimit: FILE_SAVE_RATE_LIMIT } }, async (req): Promise<StudioFile> => {
    const { id } = parseParams(idParams, req.params);
    const patch = parseBody(updateFileSchema, req.body);
    return updateFile(app.db, req.user!.id, id, patch);
  });

  app.delete(API_ROUTES.file(':id'), { preHandler: requireUser }, async (req): Promise<OkResponse> => {
    const { id } = parseParams(idParams, req.params);
    deleteFile(app.db, req.user!.id, id);
    return { ok: true };
  });

  app.post(API_ROUTES.fileRestore(':id'), { preHandler: requireUser }, async (req): Promise<StudioFile> => {
    const { id } = parseParams(idParams, req.params);
    return restoreFile(app.db, req.user!.id, id);
  });

  app.get(API_ROUTES.folders, { preHandler: requireUser }, async (req): Promise<FoldersResponse> => listFolders(app.db, req.user!.id));
};

export default fileRoutes;
