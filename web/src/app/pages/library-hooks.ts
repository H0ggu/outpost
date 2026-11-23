/**
 * Page-local TanStack Query hooks of the library pages (home, search, new profile, players,
 * bookmarks, databases, prep, broadcasts, global explorer). Same pattern as the kit's
 * `api/hooks.ts`: contract types from @outpost/shared, `api` with the abort signal, keys under
 * top-level prefixes so a whole area can be invalidated at once (`['databases']`, `['prep']`, …).
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  API_ROUTES,
  type BookmarkResponse,
  type BroadcastRound,
  type BroadcastsResponse,
  type BroadcastTour,
  type CreateDatabaseRequest,
  type CreatePrepRequest,
  type CreateProfileRequest,
  type DatabaseInfo,
  type DatabasesResponse,
  type DbGamesPage,
  type Id,
  type ImportResponse,
  type JobInfo,
  type NewSourceInput,
  type OkResponse,
  type PrepListResponse,
  type PrepReport,
  type PrepSet,
  type ProfileHeader,
  type ReferenceInfo,
  type ReferencePlayersResponse,
  type UpdateDatabaseRequest,
  type UpdatePrepRequest,
} from '@outpost/shared/api';
import { filtersKey, statsQuery, type ProfileFilters } from '@outpost/shared/filters';
import { api, ApiError } from '../api/client.ts';
import { queryKeys } from '../api/hooks.ts';
import { indexRoundPgn, type RoundPgnEntry } from './components/library/broadcastPgn.ts';

/** Query keys of the library pages (top-level prefixes: databases, prep, broadcasts, reference). */
export const libraryKeys = {
  databases: ['databases'] as const,
  database: (id: Id) => ['databases', id] as const,
  databaseGames: (id: Id, page: number, pageSize: number, q: string) =>
    ['databases', id, 'games', { page, pageSize, q }] as const,
  prepList: ['prep'] as const,
  prep: (id: Id) => ['prep', id] as const,
  prepReport: (id: Id, filters: ProfileFilters, tz: string, plies?: number) =>
    ['prep', id, 'report', filtersKey(filters), tz, plies ?? null] as const,
  broadcasts: ['broadcasts'] as const,
  broadcastTour: (tourId: string) => ['broadcasts', 'tour', tourId] as const,
  broadcastRound: (roundId: string) => ['broadcasts', 'round', roundId] as const,
  broadcastRoundPgn: (roundId: string) => ['broadcasts', 'round-pgn', roundId] as const,
  reference: ['reference'] as const,
  referencePlayers: (q: string) => ['reference', 'players', q] as const,
};

/**
 * Poll intervals (ms): a running database import, and a broadcast round (PLAN §6: clients poll
 * every 10 s). Read at call time, so tests can shorten them.
 */
export const POLL = { importMs: 1500, broadcastMs: 10_000 };

/** A job that is still queued or running. */
export const isActiveJob = (job: JobInfo | null | undefined): job is JobInfo & { status: 'queued' | 'running' } =>
  !!job && (job.status === 'queued' || job.status === 'running');

/**
 * Drops the cached queries under `queryKey` (a resource just deleted) without fetching it again:
 * the ones nothing shows go now; the ones still on screen (the page that deleted it, until it
 * has navigated away) are cancelled and go when their last observer leaves. Removing an observed
 * query instead makes its observer rebuild it on the next render and GET the deleted resource.
 */
export function forgetQueries(qc: QueryClient, queryKey: QueryKey): void {
  const cache = qc.getQueryCache();
  void qc.cancelQueries({ queryKey });
  qc.removeQueries({ queryKey, type: 'inactive' });
  const shown = new Set(cache.findAll({ queryKey }));
  if (shown.size === 0) return;
  const unsubscribe = cache.subscribe(event => {
    if (event.type !== 'observerRemoved' || !shown.has(event.query) || event.query.getObserversCount() > 0) return;
    shown.delete(event.query);
    cache.remove(event.query);
    if (shown.size === 0) unsubscribe();
  });
}

/** `value`, updated only after it has been stable for `ms` (debounced search boxes). */
export function useDebouncedValue<T>(value: T, ms = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

/** Everything that lists profiles (lists, search, bookmarks, one header) after a profile changed. */
function invalidateProfileLists(qc: QueryClient, slug?: string): Promise<unknown> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: ['profiles'] }),
    qc.invalidateQueries({ queryKey: queryKeys.bookmarks }),
    qc.invalidateQueries({ queryKey: ['search'] }),
    qc.invalidateQueries({ queryKey: libraryKeys.prepList }),
    slug ? qc.invalidateQueries({ queryKey: queryKeys.profile(slug), exact: true }) : undefined,
  ]);
}

// ---------------------------------------------------------------------------
// Profiles and bookmarks
// ---------------------------------------------------------------------------

/** `PUT` / `DELETE /api/profiles/:slug/bookmark`. */
export function useToggleBookmark() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ slug, bookmarked }: { slug: string; bookmarked: boolean }) =>
      bookmarked
        ? api.put<BookmarkResponse>(API_ROUTES.profileBookmark(slug))
        : api.del<BookmarkResponse>(API_ROUTES.profileBookmark(slug)),
    onSuccess: (_res, { slug }) => invalidateProfileLists(qc, slug),
  });
}

/** `POST /api/profiles` → `ProfileHeader`, seeded into the profile's cache so its page renders at once. */
export function useCreateProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateProfileRequest) => api.post<ProfileHeader>(API_ROUTES.profiles, body),
    onSuccess: header => {
      qc.setQueryData(queryKeys.profile(header.slug), header);
      return invalidateProfileLists(qc);
    },
  });
}

/** `POST /api/profiles/:slug/sources` (attach an account or a PGN player to an existing profile). */
export function useAddProfileSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ slug, source }: { slug: string; source: NewSourceInput }) =>
      api.post<ProfileHeader>(API_ROUTES.profileSources(slug), source),
    onSuccess: header => {
      qc.setQueryData(queryKeys.profile(header.slug), header);
      return invalidateProfileLists(qc);
    },
  });
}

// ---------------------------------------------------------------------------
// Reference database
// ---------------------------------------------------------------------------

/** `GET /api/reference` (databases, counts, attribution). */
export function useReferenceInfo(enabled = true) {
  return useQuery({
    queryKey: libraryKeys.reference,
    queryFn: ({ signal }) => api.get<ReferenceInfo>(API_ROUTES.reference, undefined, signal),
    enabled,
    staleTime: 5 * 60_000,
  });
}

/** `GET /api/reference/players?q=` (from 2 characters). */
export function useReferencePlayers(q: string) {
  const term = q.trim();
  return useQuery({
    queryKey: libraryKeys.referencePlayers(term),
    queryFn: ({ signal }) => api.get<ReferencePlayersResponse>(API_ROUTES.referencePlayers, { q: term }, signal),
    enabled: term.length >= 2,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}

// ---------------------------------------------------------------------------
// Databases
// ---------------------------------------------------------------------------

/** `GET /api/databases` (mine plus visible public and reference ones). */
export function useDatabases(enabled = true) {
  return useQuery({
    queryKey: libraryKeys.databases,
    queryFn: ({ signal }) => api.get<DatabasesResponse>(API_ROUTES.databases, undefined, signal),
    enabled,
  });
}

/** `GET /api/databases/:id`, polled while an import is queued or running. */
export function useDatabase(id: Id | undefined) {
  return useQuery({
    queryKey: libraryKeys.database(id ?? 0),
    queryFn: ({ signal }) => api.get<DatabaseInfo>(API_ROUTES.database(id!), undefined, signal),
    enabled: id !== undefined,
    refetchInterval: q => (isActiveJob(q.state.data?.importJob) ? POLL.importMs : false),
  });
}

/** `GET /api/databases/:id/games?page&pageSize&q`. */
export function useDatabaseGames(id: Id | undefined, page: number, pageSize: number, q: string) {
  const term = q.trim();
  return useQuery({
    queryKey: libraryKeys.databaseGames(id ?? 0, page, pageSize, term),
    queryFn: ({ signal }) =>
      api.get<DbGamesPage>(API_ROUTES.databaseGames(id!), { page, pageSize, q: term || undefined }, signal),
    enabled: id !== undefined,
    placeholderData: keepPreviousData,
  });
}

/** `POST /api/databases` → `DatabaseInfo`. */
export function useCreateDatabase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateDatabaseRequest) => api.post<DatabaseInfo>(API_ROUTES.databases, body),
    onSuccess: db => {
      qc.setQueryData(libraryKeys.database(db.id), db);
      return qc.invalidateQueries({ queryKey: libraryKeys.databases, exact: true });
    },
  });
}

/** `PATCH /api/databases/:id` → `DatabaseInfo`. */
export function useUpdateDatabase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: Id; patch: UpdateDatabaseRequest }) =>
      api.patch<DatabaseInfo>(API_ROUTES.database(id), patch),
    onSuccess: db => {
      qc.setQueryData(libraryKeys.database(db.id), db);
      return qc.invalidateQueries({ queryKey: libraryKeys.databases, exact: true });
    },
  });
}

/** `DELETE /api/databases/:id`. */
export function useDeleteDatabase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: Id) => api.del<OkResponse>(API_ROUTES.database(id)),
    onSuccess: (_r, id) => {
      forgetQueries(qc, libraryKeys.database(id));
      return qc.invalidateQueries({ queryKey: libraryKeys.databases, exact: true });
    },
  });
}

/** `DELETE /api/databases/:id/games/:gameId`. */
export function useDeleteDatabaseGame(id: Id) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (gameId: Id) => api.del<OkResponse>(API_ROUTES.databaseGame(id, gameId)),
    onSuccess: () => qc.invalidateQueries({ queryKey: libraryKeys.database(id) }),
  });
}

/** What to import: a `.pgn` file (multipart field `file`) or pasted PGN text. */
export type ImportInput = { file: File } | { pgn: string };

/** `POST /api/databases/:id/import` → the queued job (also written into the cached database). */
export function useImportPgn(id: Id) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ImportInput) => {
      if ('file' in input) {
        const form = new FormData();
        form.append('file', input.file, input.file.name);
        return api.post<ImportResponse>(API_ROUTES.databaseImport(id), form);
      }
      return api.post<ImportResponse>(API_ROUTES.databaseImport(id), { pgn: input.pgn });
    },
    onSuccess: ({ job }) => {
      qc.setQueryData<DatabaseInfo>(libraryKeys.database(id), d => (d ? { ...d, importJob: job } : d));
      return qc.invalidateQueries({ queryKey: libraryKeys.database(id), exact: true });
    },
  });
}

// ---------------------------------------------------------------------------
// Prep
// ---------------------------------------------------------------------------

/** `GET /api/prep`. */
export function usePrepList(enabled = true) {
  return useQuery({
    queryKey: libraryKeys.prepList,
    queryFn: ({ signal }) => api.get<PrepListResponse>(API_ROUTES.prep, undefined, signal),
    enabled,
  });
}

/** `GET /api/prep/:id`. */
export function usePrepSet(id: Id | undefined) {
  return useQuery({
    queryKey: libraryKeys.prep(id ?? 0),
    queryFn: ({ signal }) => api.get<PrepSet>(API_ROUTES.prepSet(id!), undefined, signal),
    enabled: id !== undefined,
  });
}

/**
 * `GET /api/prep/:id/report` with the filters (applied to every opponent), the activity zone and
 * the length of the repertoire lines (`plies`; the server's default when omitted).
 */
export function usePrepReport(id: Id | undefined, filters: ProfileFilters, tz: string, plies?: number, enabled = true) {
  return useQuery({
    queryKey: libraryKeys.prepReport(id ?? 0, filters, tz, plies),
    queryFn: ({ signal }) => api.get<PrepReport>(API_ROUTES.prepReport(id!), statsQuery(filters, { tz, plies }), signal),
    enabled: id !== undefined && enabled,
    placeholderData: keepPreviousData,
  });
}

/** `POST /api/prep` → `PrepSet`. */
export function useCreatePrep() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreatePrepRequest) => api.post<PrepSet>(API_ROUTES.prep, body),
    onSuccess: set => {
      qc.setQueryData(libraryKeys.prep(set.id), set);
      return qc.invalidateQueries({ queryKey: libraryKeys.prepList, exact: true });
    },
  });
}

/** `PUT /api/prep/:id` → `PrepSet` (rename, or replace the opponent list). */
export function useUpdatePrep() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: Id; body: UpdatePrepRequest }) => api.put<PrepSet>(API_ROUTES.prepSet(id), body),
    onSuccess: set => {
      qc.setQueryData(libraryKeys.prep(set.id), set);
      return Promise.all([
        qc.invalidateQueries({ queryKey: libraryKeys.prepList, exact: true }),
        qc.invalidateQueries({ queryKey: [...libraryKeys.prep(set.id), 'report'] }),
      ]);
    },
  });
}

/** `DELETE /api/prep/:id`. */
export function useDeletePrep() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: Id) => api.del<OkResponse>(API_ROUTES.prepSet(id)),
    onSuccess: (_r, id) => {
      forgetQueries(qc, libraryKeys.prep(id));
      return qc.invalidateQueries({ queryKey: libraryKeys.prepList, exact: true });
    },
  });
}

// ---------------------------------------------------------------------------
// Broadcasts
// ---------------------------------------------------------------------------

/** `GET /api/broadcasts` (active and recent official broadcasts). */
export function useBroadcasts() {
  return useQuery({
    queryKey: libraryKeys.broadcasts,
    queryFn: ({ signal }) => api.get<BroadcastsResponse>(API_ROUTES.broadcasts, undefined, signal),
    staleTime: 60_000,
    retry: broadcastRetry,
  });
}

/** `GET /api/broadcasts/tour/:tourId` (rounds of the tournament). */
export function useBroadcastTour(tourId: string | undefined) {
  return useQuery({
    queryKey: libraryKeys.broadcastTour(tourId ?? ''),
    queryFn: ({ signal }) => api.get<BroadcastTour>(API_ROUTES.broadcastTour(tourId!), undefined, signal),
    enabled: !!tourId,
    staleTime: 60_000,
    retry: broadcastRetry,
  });
}

/** `GET /api/broadcasts/round/:roundId`, polled every 10 s until the round is finished. */
export function useBroadcastRound(roundId: string | undefined) {
  return useQuery({
    queryKey: libraryKeys.broadcastRound(roundId ?? ''),
    queryFn: ({ signal }) => api.get<BroadcastRound>(API_ROUTES.broadcastRound(roundId!), undefined, signal),
    enabled: !!roundId,
    staleTime: 5_000,
    retry: broadcastRetry,
    refetchInterval: q => roundRefetchInterval(q.state.data, q.state.error),
    refetchIntervalInBackground: false,
  });
}

/**
 * The round's PGN (`GET /api/broadcasts/round/:id.pgn`, every board with clocks and comments: a
 * few MB for a big round), cut into games without parsing the moves, and kept for one poll
 * interval so opening another board soon after doesn't download it again. Cancel it with
 * `qc.cancelQueries({ queryKey: libraryKeys.broadcastRoundPgn(roundId) })` (aborts the download).
 */
export function fetchRoundPgnGames(qc: QueryClient, roundId: string): Promise<RoundPgnEntry[]> {
  return qc.fetchQuery({
    queryKey: libraryKeys.broadcastRoundPgn(roundId),
    queryFn: ({ signal }) => api.text(API_ROUTES.broadcastRoundPgn(roundId), undefined, signal).then(indexRoundPgn),
    staleTime: POLL.broadcastMs,
    gcTime: POLL.broadcastMs,
    structuralSharing: false,
    retry: false,
  });
}

/** Poll a round every 10 s until it is finished or fails for good. */
export const roundRefetchInterval = (data: BroadcastRound | undefined, error: unknown): number | false =>
  data?.round.finished || isPermanentError(error) ? false : POLL.broadcastMs;

/**
 * The server has no Lichess API token for an endpoint that needs one: 503 `upstream_unavailable`
 * with `details.reason: 'no_token'` (server `upstreamHttpError`). Other 503s (Lichess unreachable,
 * rate-limited, timed out) are transient.
 */
export const isNoTokenError = (e: unknown): boolean =>
  e instanceof ApiError &&
  e.code === 'upstream_unavailable' &&
  typeof e.details === 'object' &&
  e.details !== null &&
  (e.details as { reason?: unknown }).reason === 'no_token';

/** Errors that polling again won't fix: not found, not allowed, no Lichess token on the server. */
export const isPermanentError = (e: unknown): boolean =>
  isNoTokenError(e) || (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 429);

/** Query retry for the broadcast endpoints: the shared policy, minus retries a missing token can't pass. */
const broadcastRetry = (failures: number, e: Error): boolean =>
  !isNoTokenError(e) && !(e instanceof ApiError && e.status >= 400 && e.status < 500) && failures < 2;
