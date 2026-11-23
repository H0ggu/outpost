import type { FastifyPluginAsync } from 'fastify';

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
 * Every route: { preHandler: requireUser }; users only ever see their own files. Fastify matches the static /api/files/search before /api/files/:id, whatever the registration order.
 *
 * TODO(profiles): implement. Keep this file thin: validate with src/http/validate.ts, check access
 * with the preHandlers in src/auth/session.ts, call into the module, return contract types, and
 * throw HttpError (src/http/errors.ts) for failures. Build paths from API_ROUTES (pass ':param'
 * placeholders, e.g. API_ROUTES.profile(':slug')).
 */
const fileRoutes: FastifyPluginAsync = async _app => {
  // TODO(profiles)
};

export default fileRoutes;
