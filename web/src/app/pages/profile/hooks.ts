/**
 * Profile-only hooks: the context the layout hands to its tabs, profile mutations, a few
 * endpoint hooks only these pages use, and small UI helpers (clock, element size, URL params).
 * Query keys live under the existing `queryKeys.profile(slug)` prefix (docs/CONVENTIONS.md).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useOutletContext, useSearchParams } from 'react-router';
import {
  API_ROUTES,
  type AddSourceRequest,
  type BookmarkResponse,
  type DatabasesResponse,
  type GameResponse,
  type Id,
  type OkResponse,
  type OpponentsPage,
  type ProfileHeader,
  type ProfileStatus,
  type ProfileUpdateResponse,
  type UpdateProfileRequest,
  type UserPrefs,
} from '@outpost/shared/api';
import { statsQuery } from '@outpost/shared/filters';
import { api } from '../../api/client.ts';
import { queryKeys } from '../../api/hooks.ts';

// ---------------------------------------------------------------------------
// Layout → tab context
// ---------------------------------------------------------------------------

/** What ProfileLayout passes to every tab through `<Outlet context>`. */
export interface ProfileContext {
  slug: string;
  header: ProfileHeader;
  prefs: UserPrefs;
  signedIn: boolean;
  /** IANA zone for dates and activity buckets (prefs.timezone: the browser's zone or UTC). */
  timeZone: string;
  /** Switches the viewer's time-zone preference (saved to the account when signed in). */
  setTimeZonePref: (tz: UserPrefs['timezone']) => void;
}

/** The current profile, from ProfileLayout. */
export const useProfile = (): ProfileContext => useOutletContext<ProfileContext>();

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/** `PUT` / `DELETE /api/profiles/:slug/bookmark`, updating the cached header. */
export function useToggleBookmark(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (bookmark: boolean) =>
      bookmark
        ? api.put<BookmarkResponse>(API_ROUTES.profileBookmark(slug))
        : api.del<BookmarkResponse>(API_ROUTES.profileBookmark(slug)),
    onSuccess: r => {
      qc.setQueryData<ProfileHeader>(queryKeys.profile(slug), h => (h ? { ...h, bookmarked: r.bookmarked } : h));
      void qc.invalidateQueries({ queryKey: queryKeys.bookmarks });
    },
  });
}

/** `POST /api/profiles/:slug/update`: enqueue a sync of every source. */
export function useRequestUpdate(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<ProfileUpdateResponse>(API_ROUTES.profileUpdate(slug)),
    onSuccess: r => {
      qc.setQueryData<ProfileStatus>(queryKeys.profileStatus(slug), s => (s ? { ...s, queue: r.queue } : s));
      qc.setQueryData<ProfileHeader>(queryKeys.profile(slug), h => (h ? { ...h, queue: r.queue } : h));
      void qc.invalidateQueries({ queryKey: queryKeys.profileStatus(slug) });
      void qc.invalidateQueries({ queryKey: queryKeys.myJobs });
    },
  });
}

/** Stores a fresh header under its (possibly new) slug. */
function storeHeader(qc: ReturnType<typeof useQueryClient>, h: ProfileHeader): void {
  qc.setQueryData<ProfileHeader>(queryKeys.profile(h.slug), h);
}

/** `PATCH /api/profiles/:slug`. When the slug changes, the caller navigates to the new address. */
export function usePatchProfile(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateProfileRequest) => api.patch<ProfileHeader>(API_ROUTES.profile(slug), body),
    onSuccess: (h, body) => {
      storeHeader(qc, h);
      if (h.slug !== slug) qc.removeQueries({ queryKey: queryKeys.profile(slug) });
      // Hiding or showing a source changes every statistic.
      else if (body.hiddenSourceIds) void qc.invalidateQueries({ queryKey: queryKeys.profile(slug) });
      void qc.invalidateQueries({ queryKey: ['profiles'] });
      void qc.invalidateQueries({ queryKey: queryKeys.bookmarks });
    },
  });
}

/**
 * `DELETE /api/profiles/:slug`. The caller navigates away on success. The profile's cached
 * queries are dropped only when the calling component unmounts (that is, once the profile pages
 * are gone): removing them earlier would make the still-mounted layout refetch the deleted
 * profile, logging a 404 and flashing a spinner before the navigation lands.
 */
export function useDeleteProfile(slug: string) {
  const qc = useQueryClient();
  const deleted = useRef<string | null>(null);
  useEffect(
    () => () => {
      if (deleted.current !== null) qc.removeQueries({ queryKey: queryKeys.profile(deleted.current) });
    },
    [qc],
  );
  return useMutation({
    mutationFn: () => api.del<OkResponse>(API_ROUTES.profile(slug)),
    onSuccess: async () => {
      deleted.current = slug;
      await qc.cancelQueries({ queryKey: queryKeys.profile(slug) });
      void qc.invalidateQueries({ queryKey: ['profiles'] });
      void qc.invalidateQueries({ queryKey: queryKeys.bookmarks });
    },
  });
}

/** `POST /api/profiles/:slug/sources`. */
export function useAddSource(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AddSourceRequest) => api.post<ProfileHeader>(API_ROUTES.profileSources(slug), body),
    onSuccess: h => {
      storeHeader(qc, h);
      void qc.invalidateQueries({ queryKey: queryKeys.profile(slug) });
    },
  });
}

/** `DELETE /api/profiles/:slug/sources/:sourceId`. */
export function useRemoveSource(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sourceId: Id) => api.del<ProfileHeader>(API_ROUTES.profileSource(slug, sourceId)),
    onSuccess: h => {
      storeHeader(qc, h);
      void qc.invalidateQueries({ queryKey: queryKeys.profile(slug) });
    },
  });
}

// ---------------------------------------------------------------------------
// Queries only the profile pages use
// ---------------------------------------------------------------------------

/** `GET /api/games/:id` (PGN + metadata) for a game preview. */
export function useGame(slug: string, id: Id | null) {
  return useQuery({
    queryKey: [...queryKeys.profile(slug), 'game', id],
    queryFn: ({ signal }) => api.get<GameResponse>(API_ROUTES.game(id!), undefined, signal),
    enabled: id !== null,
    staleTime: Infinity,
  });
}

/** Most opponents the name suggestions offer (the endpoint's page-size cap). */
export const OPPONENT_SUGGESTIONS = 100;

/**
 * Names of the most played opponents (all games, unfiltered), for the opponent filter's
 * suggestions. Loaded only once `enabled` (the field got focus). Shares the cache entry of an
 * identical `useOpponents` call.
 */
export function useOpponentNames(slug: string, enabled: boolean): string[] {
  const extra = { view: 'most', page: 1, pageSize: OPPONENT_SUGGESTIONS };
  const q = useQuery({
    queryKey: queryKeys.stats(slug, 'opponents', {}, extra),
    queryFn: ({ signal }) => api.get<OpponentsPage>(API_ROUTES.stats.opponents(slug), statsQuery({}, extra), signal),
    enabled,
    staleTime: 5 * 60_000,
  });
  return useMemo(() => [...new Set(q.data?.rows.map(r => r.name) ?? [])], [q.data]);
}

/** `GET /api/databases` (to attach a PGN-database player as a source). */
export function useDatabases(slug: string, enabled: boolean) {
  return useQuery({
    queryKey: [...queryKeys.profile(slug), 'databases'],
    queryFn: ({ signal }) => api.get<DatabasesResponse>(API_ROUTES.databases, undefined, signal),
    enabled,
    staleTime: 60_000,
  });
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

/** The current time, re-rendering every `intervalMs` while `active`. */
export function useNow(intervalMs = 1000, active = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs, active]);
  return now;
}

/** Width of an element (ResizeObserver), or `fallback` before the first measurement. */
export function useElementWidth(ref: RefObject<HTMLElement | null>, fallback = 640): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWidth(Math.round(el.getBoundingClientRect().width));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width > 0 ? width : fallback;
}

/**
 * A page-specific URL query parameter (never a filter key), e.g. `view`, `order`, `page`.
 * Setting the default value removes it from the URL. `resetPage` also drops `page`.
 */
export function useQueryParam<T extends string>(
  name: string,
  parse: (raw: string | null) => T,
  defaultValue: T,
): [T, (value: T, opts?: { resetPage?: boolean; replace?: boolean }) => void] {
  const [params, setParams] = useSearchParams();
  const value = parse(params.get(name));
  const set = useCallback(
    (next: T, opts: { resetPage?: boolean; replace?: boolean } = {}) => {
      setParams(
        prev => {
          const out = new URLSearchParams(prev);
          if (next === defaultValue) out.delete(name);
          else out.set(name, next);
          if (opts.resetPage) out.delete('page');
          return out;
        },
        { replace: opts.replace ?? false },
      );
    },
    [name, defaultValue, setParams],
  );
  return [value, set];
}

/** Sets several page-specific URL parameters in one navigation (`null` or `''` removes one). */
export function useSetQueryParams(): (updates: Record<string, string | null>) => void {
  const [, setParams] = useSearchParams();
  return useCallback(
    (updates: Record<string, string | null>) =>
      setParams(prev => {
        const out = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(updates)) {
          if (v === null || v === '') out.delete(k);
          else out.set(k, v);
        }
        return out;
      }),
    [setParams],
  );
}

/** Parser for `useQueryParam` that accepts one of `values`, else the default. */
export const oneOf =
  <T extends string>(values: readonly T[], defaultValue: T) =>
  (raw: string | null): T =>
    raw !== null && (values as readonly string[]).includes(raw) ? (raw as T) : defaultValue;

/** The 1-based `page` URL parameter and a setter. */
export function usePageParam(): [number, (page: number) => void] {
  const [params, setParams] = useSearchParams();
  const raw = Number(params.get('page'));
  const page = Number.isInteger(raw) && raw >= 1 ? raw : 1;
  const set = useCallback(
    (next: number) =>
      setParams(prev => {
        const out = new URLSearchParams(prev);
        if (next <= 1) out.delete('page');
        else out.set('page', String(next));
        return out;
      }),
    [setParams],
  );
  return [page, set];
}

/** Matches a CSS media query (false on the server / in tests without matchMedia). */
export function useMediaQuery(query: string): boolean {
  const get = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(query);
    const on = () => setMatches(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return matches;
}
