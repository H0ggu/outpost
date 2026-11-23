/**
 * My Files client (PLAN §6 "Databases, files…", contract in shared/src/api.ts): every call is the
 * signed-in user's own files. Errors are `ApiError`s from the shared client (409 `conflict` when
 * another tab or device saved the file first).
 */
import {
  API_ROUTES,
  type CreateFileRequest,
  type FileSearchResponse,
  type FilesResponse,
  type FoldersResponse,
  type Id,
  type OkResponse,
  type StudioFile,
  type UpdateFileRequest,
} from '@outpost/shared/api';
import { api } from '../app/api/client.ts';

export const filesApi = {
  /** Every file outside the recycle bin (metadata only). */
  list: (): Promise<FilesResponse> => api.get<FilesResponse>(API_ROUTES.files),
  /** The recycle bin. */
  trash: (): Promise<FilesResponse> => api.get<FilesResponse>(API_ROUTES.files, { trash: '1' }),
  folders: (): Promise<FoldersResponse> => api.get<FoldersResponse>(API_ROUTES.folders),
  get: (id: Id): Promise<StudioFile> => api.get<StudioFile>(API_ROUTES.file(id)),
  create: (req: CreateFileRequest): Promise<StudioFile> => api.post<StudioFile>(API_ROUTES.files, req),
  update: (id: Id, req: UpdateFileRequest): Promise<StudioFile> => api.put<StudioFile>(API_ROUTES.file(id), req),
  /** Moves a file to the recycle bin; on a file already there, deletes it for good. */
  remove: (id: Id): Promise<OkResponse> => api.del<OkResponse>(API_ROUTES.file(id)),
  restore: (id: Id): Promise<StudioFile> => api.post<StudioFile>(API_ROUTES.fileRestore(id)),
  /** Files containing a position. */
  search: (fen: string): Promise<FileSearchResponse> => api.get<FileSearchResponse>(API_ROUTES.filesSearch, { fen }),
};
