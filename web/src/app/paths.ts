/**
 * SPA route paths (PLAN §9) and Studio links (PLAN §8.4). Link with these instead of
 * hand-written strings, so routes can move without hunting for literals.
 */
import { encodeFiltersSegment, filtersToQuery, withQuery, type ProfileFilters } from '@outpost/shared/filters';
import type { Color, Id } from '@outpost/shared/api';

const enc = encodeURIComponent;

/** Profile tabs, in display order (`''` = Overview). */
export const PROFILE_TABS = [
  { tab: '', label: 'Overview' },
  { tab: 'games', label: 'Games' },
  { tab: 'explorer', label: 'Explorer' },
  { tab: 'openings', label: 'Openings' },
  { tab: 'opponents', label: 'Opponents' },
  { tab: 'worldmap', label: 'World map' },
  { tab: 'activity', label: 'Activity' },
  { tab: 'rating', label: 'Rating' },
] as const;
/** Profile tab path segment. */
export type ProfileTab = (typeof PROFILE_TABS)[number]['tab'] | 'settings';

/** Tabs that share the filters bar (state lives in the URL query, PLAN §9). */
export const FILTERED_TABS: readonly ProfileTab[] = ['games', 'explorer', 'openings', 'opponents'];

/** Query parameters understood by studio.html (PLAN §8.4). */
export interface StudioQuery {
  /** Outpost game id to open. */
  game?: Id;
  /** My Files id to open. */
  file?: Id;
  /** PGN text to open. */
  pgn?: string;
  /** FEN to set up. */
  fen?: string;
  /** Explorer to open: `masters`, `lichess`, or `player:<spec>` (see parsePlayerSpec). */
  explorer?: 'masters' | 'lichess' | `player:${string}`;
  /** Player explorer colour. */
  color?: Color;
  /** Outpost filters, as an explorer path segment (encodeFiltersSegment). */
  filters?: string;
  /** `explorer` = minimal chrome for the profile Explorer tab iframe. */
  embed?: 'explorer';
}

/** All SPA paths. */
export const paths = {
  home: '/',
  login: (next?: string) => withQuery('/login', { next }),
  setup: '/setup',
  signup: (invite?: string) => withQuery('/signup', { invite }),
  search: (q?: string) => withQuery('/search', { q }),

  /** A profile tab, optionally with filters in the query. */
  profile: (slug: string, tab: ProfileTab = '', filters?: ProfileFilters) => {
    const base = `/u/${enc(slug)}${tab ? `/${tab}` : ''}`;
    return filters ? withQuery(base, filtersToQuery(filters)) : base;
  },
  newProfile: '/profiles/new',
  players: '/players',
  bookmarks: '/bookmarks',

  databases: '/databases',
  database: (id: Id) => `/databases/${id}`,

  prepList: '/prep',
  prep: (id: Id) => `/prep/${id}`,

  broadcasts: '/broadcasts',
  broadcastRound: (roundId: string) => `/broadcasts/${enc(roundId)}`,

  /** Global explorer (redirects into the Studio with the explorer open). */
  explorer: '/explorer',
  settings: '/settings',

  admin: {
    root: '/admin',
    settings: '/admin/settings',
    users: '/admin/users',
    jobs: '/admin/jobs',
    reference: '/admin/reference',
  },

  /** The Studio is a separate page (studio.html): link to it with a full page load. */
  studio: (q: StudioQuery = {}) => withQuery('/studio', { ...q }),
} as const;

/** Studio link for a profile's player explorer with its current filters. */
export const studioPlayerExplorer = (slug: string, color: Color, filters: ProfileFilters, embed = false): string =>
  paths.studio({
    explorer: `player:${slug}`,
    color,
    filters: encodeFiltersSegment(filters),
    ...(embed ? { embed: 'explorer' as const } : {}),
  });

/**
 * The site's main navigation, in order: the SPA header and the Studio's header (a separate page,
 * which links back with full page loads) both draw it, then add the Studio itself.
 */
export const MAIN_NAV: ReadonlyArray<{ readonly href: string; readonly label: string; readonly end?: boolean }> = [
  { href: paths.home, label: 'Home', end: true },
  { href: paths.players, label: 'Players' },
  { href: paths.databases, label: 'Databases' },
  { href: paths.prepList, label: 'Prep' },
  { href: paths.broadcasts, label: 'Broadcasts' },
  { href: paths.explorer, label: 'Explorer' },
];
