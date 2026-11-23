/**
 * TanStack Query hooks for the main endpoints, typed by @outpost/shared. Page modules add
 * their own hooks next to their pages for endpoints only they use, following the same pattern:
 * a key from `queryKeys`, `api.get` with the abort signal, contract types.
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';
import {
  API_ROUTES,
  type ActivityStats,
  type BehaviourStats,
  type GamesPage,
  type MyJobsResponse,
  type OpeningsParams,
  type OpeningsResponse,
  type OpponentsPage,
  type OpponentsParams,
  type OverviewStats,
  type ProfileHeader,
  type ProfileListQuery,
  type ProfileListResponse,
  type ProfileStatus,
  type RatingStats,
  type SearchResults,
  type SessionInfo,
  type UpdatePrefsRequest,
  type UserPrefs,
  type WorldMapStats,
} from '@outpost/shared/api';
import {
  FILTER_KEYS,
  filtersKey,
  filtersToQuery,
  parseFilters,
  statsQuery,
  type ProfileFilters,
  type QueryValue,
} from '@outpost/shared/filters';
import { api } from './client.ts';

/** Stats endpoint names (keys of API_ROUTES.stats that return JSON). */
export type StatsKind = Exclude<keyof typeof API_ROUTES.stats, 'gamesPgn'>;

/** Query keys. Invalidate `['profile', slug]` to refresh everything about a profile. */
export const queryKeys = {
  session: ['session'] as const,
  profile: (slug: string) => ['profile', slug] as const,
  profileStatus: (slug: string) => ['profile', slug, 'status'] as const,
  stats: (slug: string, kind: StatsKind, filters: ProfileFilters, extra: Record<string, QueryValue> = {}) =>
    ['profile', slug, 'stats', kind, filtersKey(filters), extra] as const,
  profiles: (scope: ProfileListQuery['scope']) => ['profiles', scope] as const,
  bookmarks: ['bookmarks'] as const,
  search: (q: string) => ['search', q] as const,
  myJobs: ['jobs', 'mine'] as const,
};

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/** `GET /api/session` — who am I, is setup needed, signup mode. */
export function useSession() {
  return useQuery({
    queryKey: queryKeys.session,
    queryFn: ({ signal }) => api.get<SessionInfo>(API_ROUTES.session, undefined, signal),
    staleTime: 5 * 60_000,
  });
}

/** `POST /api/logout`, then refetch the session and drop cached data. */
export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post(API_ROUTES.logout),
    onSettled: async () => {
      qc.removeQueries({ predicate: q => q.queryKey[0] !== 'session' });
      await qc.invalidateQueries({ queryKey: queryKeys.session });
    },
  });
}

/** `PUT /api/me/prefs` (partial), updating the cached session. */
export function useUpdatePrefs() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: UpdatePrefsRequest) => api.put<UserPrefs>(API_ROUTES.me.prefs, patch),
    onSuccess: prefs =>
      qc.setQueryData<SessionInfo>(queryKeys.session, s => (s?.user ? { ...s, user: { ...s.user, prefs } } : s)),
  });
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

/** `GET /api/profiles/:slug`. */
export function useProfileHeader(slug: string | undefined) {
  return useQuery({
    queryKey: queryKeys.profile(slug ?? ''),
    queryFn: ({ signal }) => api.get<ProfileHeader>(API_ROUTES.profile(slug!), undefined, signal),
    enabled: !!slug,
  });
}

/** `GET /api/profiles/:slug/status`, polled every 3 s while a sync is queued or running. */
export function useProfileStatus(slug: string | undefined, poll: boolean) {
  return useQuery({
    queryKey: queryKeys.profileStatus(slug ?? ''),
    queryFn: ({ signal }) => api.get<ProfileStatus>(API_ROUTES.profileStatus(slug!), undefined, signal),
    enabled: !!slug,
    refetchInterval: q => (poll || q.state.data?.queue.busy ? 3000 : false),
  });
}

/** `GET /api/profiles?scope=`. */
export function useProfiles(scope: ProfileListQuery['scope']) {
  return useQuery({
    queryKey: queryKeys.profiles(scope),
    queryFn: ({ signal }) => api.get<ProfileListResponse>(API_ROUTES.profiles, { scope }, signal),
  });
}

/** `GET /api/bookmarks`. */
export function useBookmarks() {
  return useQuery({
    queryKey: queryKeys.bookmarks,
    queryFn: ({ signal }) => api.get<ProfileListResponse>(API_ROUTES.bookmarks, undefined, signal),
  });
}

/** `GET /api/search?q=` (from 2 characters). */
export function useSearch(q: string) {
  const term = q.trim();
  return useQuery({
    queryKey: queryKeys.search(term),
    queryFn: ({ signal }) => api.get<SearchResults>(API_ROUTES.search, { q: term }, signal),
    enabled: term.length >= 2,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}

/** `GET /api/jobs/mine`, polled while anything is queued or running. */
export function useMyJobs(enabled = true) {
  return useQuery({
    queryKey: queryKeys.myJobs,
    queryFn: ({ signal }) => api.get<MyJobsResponse>(API_ROUTES.jobsMine, undefined, signal),
    enabled,
    refetchInterval: q => (q.state.data?.jobs.length ? 5000 : false),
  });
}

// ---------------------------------------------------------------------------
// Stats (all take ProfileFilters)
// ---------------------------------------------------------------------------

function useStats<T>(slug: string | undefined, kind: StatsKind, filters: ProfileFilters, extra: Record<string, QueryValue> = {}) {
  return useQuery({
    queryKey: queryKeys.stats(slug ?? '', kind, filters, extra),
    queryFn: ({ signal }) => api.get<T>(API_ROUTES.stats[kind](slug!), statsQuery(filters, extra), signal),
    enabled: !!slug,
    placeholderData: keepPreviousData,
  });
}

/** `GET /api/profiles/:slug/overview`. */
export const useOverview = (slug: string | undefined, filters: ProfileFilters) =>
  useStats<OverviewStats>(slug, 'overview', filters);

/** `GET /api/profiles/:slug/games` (page is 1-based, pageSize defaults to 20). */
export const useProfileGames = (slug: string | undefined, filters: ProfileFilters, page = 1, pageSize = 20) =>
  useStats<GamesPage>(slug, 'games', filters, { page, pageSize });

/** `GET /api/profiles/:slug/openings` (filters plus the endpoint's own params). */
export const useOpenings = (slug: string | undefined, filters: ProfileFilters, opts: OpeningsParams = {}) =>
  useStats<OpeningsResponse>(slug, 'openings', filters, { ...opts });

/** `GET /api/profiles/:slug/opponents` (filters plus the endpoint's own params). */
export const useOpponents = (slug: string | undefined, filters: ProfileFilters, opts: OpponentsParams = {}) =>
  useStats<OpponentsPage>(slug, 'opponents', filters, { ...opts });

/** `GET /api/profiles/:slug/behaviour`. */
export const useBehaviour = (slug: string | undefined, filters: ProfileFilters) =>
  useStats<BehaviourStats>(slug, 'behaviour', filters);

/** `GET /api/profiles/:slug/worldmap`. */
export const useWorldMap = (slug: string | undefined, filters: ProfileFilters) =>
  useStats<WorldMapStats>(slug, 'worldmap', filters);

/** `GET /api/profiles/:slug/activity` bucketed in `tz` (default: the browser's zone). */
export const useActivity = (slug: string | undefined, filters: ProfileFilters, tz: string = browserTimeZone()) =>
  useStats<ActivityStats>(slug, 'activity', filters, { tz });

/**
 * `GET /api/profiles/:slug/rating` (`RatingQuery` = the filters). To chart one source or time
 * class, narrow `filters.src` / `filters.tc`.
 */
export const useRatingStats = (slug: string | undefined, filters: ProfileFilters) =>
  useStats<RatingStats>(slug, 'rating', filters);

/** The browser's IANA time zone (UTC if unknown). */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

// ---------------------------------------------------------------------------
// Filters in the URL
// ---------------------------------------------------------------------------

/**
 * The profile filters held in the URL query (PLAN §9): parsed leniently, and a setter that
 * rewrites only the filter keys (other params such as `page` are kept unless `resetPage`).
 */
export function useUrlFilters(): [ProfileFilters, (next: ProfileFilters, opts?: { resetPage?: boolean }) => void] {
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => parseFilters(params, 'lenient'), [params]);
  const setFilters = useCallback(
    (next: ProfileFilters, opts: { resetPage?: boolean } = { resetPage: true }) => {
      setParams(
        prev => {
          const out = new URLSearchParams(prev);
          for (const k of FILTER_KEYS) out.delete(k);
          if (opts.resetPage) out.delete('page');
          for (const [k, v] of filtersToQuery(next)) out.set(k, v);
          return out;
        },
        { replace: false },
      );
    },
    [setParams],
  );
  return [filters, setFilters];
}
