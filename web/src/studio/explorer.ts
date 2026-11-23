/**
 * lila's opening explorer wired to Outpost (PLAN §8.3, scripts/lila-patches/002):
 *   - masters / lichess / reference → `${origin}/api/explorer/<db>` (`explorerEndpoint`, absolute
 *     because lila resolves `new URL('./<db>', endpoint)`);
 *   - player → `/api/explorer/player` with `player=<profile slug | lichess:… | chesscom:… | db:… | ref:…>`,
 *     or `/api/explorer/f/<filters>/player` for the profile the Studio was opened with (?filters=);
 *   - tablebase → `/api/tablebase/<variant>`;
 *   - game links open in Outpost (stored games, masters PGN) or on lichess.org (Lichess database games).
 */
import {
  API_ROUTES,
  explorerEndpoint,
  SEARCH_QUERY_MIN_LENGTH,
  type Color,
  type DatabaseInfo,
  type DatabasesResponse,
  type ProfileHeader,
  type ProfileListResponse,
  type SearchResults,
} from '@outpost/shared/api';
import { parsePlayerSpec } from '@outpost/shared/filters';
import { api } from '../app/api/client.ts';

// Structural copies of lila's explorer types (lila-types/analyse/interfaces.d.ts, patch 002), so this
// module has no lila import and is unit-tested; boot.ts hands the result to lila, which checks them.

/** lila's explorer databases, plus Outpost's local reference DB. */
export type ExplorerDb = 'lichess' | 'masters' | 'player' | 'reference';

/** A player offered by the player picker. */
export interface ExplorerPlayerChoice {
  spec: string;
  label: string;
  hint?: string;
}

/** `opts.explorer` for lila, with the `outpost` hooks of scripts/lila-patches/002. */
export interface ExplorerOpts {
  endpoint: string;
  tablebaseEndpoint: string;
  showRatings: boolean;
  outpost: {
    playerEndpoint(player: string): string;
    playerLabel(player: string): string;
    searchPlayers(term: string): Promise<ExplorerPlayerChoice[]>;
    suggestedPlayers(onLoad?: () => void): ExplorerPlayerChoice[];
    openGame(db: ExplorerDb, id: string, orientation: Color, fen: string): void;
    requiresAuth(): boolean;
    readonly loginUrl: string;
  };
}

/** What the explorer needs from the rest of the Studio. */
export interface ExplorerDeps {
  origin: string;
  /** The profile (spec) the page was opened for, whose filters segment applies. */
  filtered?: { player: string; segment: string };
  signedIn: () => boolean;
  anonymousBrowsing: () => boolean;
  loginUrl: () => string;
  redraw: () => void;
  openGame: (db: ExplorerDb, id: string, orientation: Color, fen: string) => void;
}

const SITE_LABELS: Readonly<Record<string, string>> = { lichess: 'Lichess', chesscom: 'Chess.com' };

/** Label for a player spec before (or without) asking the server. */
export function fallbackPlayerLabel(spec: string): string {
  const p = parsePlayerSpec(spec);
  if (!p) return spec;
  switch (p.kind) {
    case 'profile':
      return p.slug;
    case 'lichess':
    case 'chesscom':
      return `${p.username} (${SITE_LABELS[p.kind]})`;
    case 'db':
      return `Database ${p.databaseId}`;
    case 'ref':
      return `FIDE ${p.fideId}`;
  }
}

/** Builds lila's `ExplorerOpts` for the Studio. */
export function makeExplorerOpts(deps: ExplorerDeps): ExplorerOpts {
  const labels = new Map<string, string>();
  const asked = new Set<string>();
  let suggestions: ExplorerPlayerChoice[] = [];
  let suggestionsState: 'idle' | 'loading' | 'ready' = 'idle';
  /** Redraws of player dialogs that asked before the suggestions arrived (lila's dialog redraw). */
  const waiting = new Set<() => void>();

  const learnLabel = (spec: string): void => {
    if (asked.has(spec) || (!deps.signedIn() && !deps.anonymousBrowsing())) return;
    asked.add(spec);
    const p = parsePlayerSpec(spec);
    const done = (label: string | undefined) => {
      if (!label) return;
      labels.set(spec, label);
      deps.redraw();
    };
    if (p?.kind === 'profile')
      api.get<ProfileHeader>(API_ROUTES.profile(p.slug)).then(h => done(h.displayName), () => undefined);
    else if (p?.kind === 'db')
      api.get<DatabaseInfo>(API_ROUTES.database(p.databaseId)).then(d => done(d.name), () => undefined);
  };

  const loadSuggestions = (): void => {
    if (suggestionsState !== 'idle' || !deps.signedIn()) return;
    suggestionsState = 'loading';
    const toChoices = (r: ProfileListResponse, hint: string): ExplorerPlayerChoice[] =>
      r.profiles.map(p => {
        labels.set(p.slug, p.displayName);
        return { spec: p.slug, label: p.displayName, hint };
      });
    // "My DBs" (PLAN §5): the PGN databases this user may read (theirs and public ones) as
    // `db:<id>` players, after the profiles.
    const toDbChoices = (r: DatabasesResponse): ExplorerPlayerChoice[] =>
      (Array.isArray(r?.databases) ? r.databases : [])
        .filter(d => d.kind === 'games' && d.gameCount > 0)
        .map(d => {
          const spec = `db:${d.id}`;
          labels.set(spec, d.name);
          return { spec, label: d.name, hint: d.canEdit ? 'my database' : 'database' };
        });
    Promise.allSettled([
      api.get<ProfileListResponse>(API_ROUTES.bookmarks),
      api.get<ProfileListResponse>(API_ROUTES.profiles, { scope: 'mine' }),
      api.get<ProfileListResponse>(API_ROUTES.profiles, { scope: 'recent' }),
      api.get<DatabasesResponse>(API_ROUTES.databases),
    ]).then(([bookmarks, mine, recent, databases]) => {
      const profiles = [
        ...(bookmarks.status === 'fulfilled' ? toChoices(bookmarks.value, 'bookmarked') : []),
        ...(mine.status === 'fulfilled' ? toChoices(mine.value, 'mine') : []),
        ...(recent.status === 'fulfilled' ? toChoices(recent.value, 'recent') : []),
      ];
      const seen = new Set<string>();
      suggestions = [
        ...profiles.filter(c => !seen.has(c.spec) && seen.add(c.spec)).slice(0, 12),
        ...(databases.status === 'fulfilled' ? toDbChoices(databases.value).slice(0, 8) : []),
      ];
      suggestionsState = 'ready';
      const redraws = [...waiting];
      waiting.clear();
      deps.redraw();
      for (const redraw of redraws) redraw();
    });
  };

  return {
    endpoint: explorerEndpoint(deps.origin),
    tablebaseEndpoint: '/api/tablebase',
    showRatings: true,
    outpost: {
      playerEndpoint: player =>
        deps.filtered && deps.filtered.player === player
          ? explorerEndpoint(deps.origin, deps.filtered.segment)
          : explorerEndpoint(deps.origin),
      playerLabel: player => {
        const known = labels.get(player);
        if (known) return known;
        learnLabel(player);
        return fallbackPlayerLabel(player);
      },
      async searchPlayers(term) {
        const q = term.trim();
        if (q.length < SEARCH_QUERY_MIN_LENGTH) return [];
        const r = await api.get<SearchResults>(API_ROUTES.search, { q });
        const choices: ExplorerPlayerChoice[] = [];
        for (const p of r.profiles) {
          labels.set(p.slug, p.displayName);
          choices.push({ spec: p.slug, label: p.displayName, hint: 'profile' });
        }
        for (const hit of [...r.lichess, ...r.chesscom])
          if (hit.profileSlug === null && hit.known)
            choices.push({ spec: `${hit.kind}:${hit.username.toLowerCase()}`, label: hit.username, hint: SITE_LABELS[hit.kind] });
        for (const ref of r.reference)
          if (ref.fideId && ref.profileSlug === null)
            choices.push({ spec: `ref:${ref.fideId}`, label: ref.name, hint: 'reference DB' });
        return choices.slice(0, 20);
      },
      suggestedPlayers: onLoad => {
        if (suggestionsState !== 'ready' && onLoad && deps.signedIn()) waiting.add(onLoad);
        loadSuggestions();
        return suggestions;
      },
      openGame: deps.openGame,
      requiresAuth: () => !deps.signedIn() && !deps.anonymousBrowsing(),
      get loginUrl() {
        return deps.loginUrl();
      },
    },
  };
}
