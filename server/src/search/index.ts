/**
 * Unified player search, `GET /api/search?q=` (PLAN §5 "Unified search", §6).
 *
 * One request fans out, in parallel:
 * - Lichess autocomplete (`/api/player/autocomplete?term=&object=true`, from 3 characters);
 * - a Chess.com exact-username check (`/pub/player/{u}`: 404 = no such user; there is no search API);
 * - Outpost's own index of known usernames: sources, `players_cache` and opponents already seen
 *   in `player_games` (prefix match, so Chess.com accounts can be found by prefix too);
 * - reference-DB players (`searchReferencePlayers`, owned by the reference module);
 * - local profiles the viewer may see (name, address, or a visible account's name).
 *
 * Upstream calls go through `app.upstream` with a short deadline that covers the response body
 * too (`upstreamJsonWithin`), and stop when the client goes away; a failure leaves that site's
 * upstream hits out (local hits stay) and lists the site in `unavailable`. Answers are cached
 * per app for a minute so typing doesn't hammer Lichess / Chess.com.
 *
 * "Known" accounts (local hits, `known`) are the ones with imported games, or in a profile the
 * viewer may see: a source row that only a private profile uses doesn't reveal that someone
 * tracks the account.
 */
import {
  SEARCH_QUERY_MAX_LENGTH,
  SEARCH_QUERY_MIN_LENGTH,
  type ExternalPlayerHit,
  type Id,
  type ProfileSummary,
  type ReferencePlayer,
  type SearchResults,
  type Title,
} from '@outpost/shared/api';
import { isTitle, playerKey } from '@outpost/shared/chess';
import type { Db } from '../db/index.ts';
import type { AuthUser } from '../http/types.ts';
import { UPSTREAM, type Upstream } from '../http/upstream.ts';
import { profileSummaries } from '../profiles/service.ts';
import { CHESSCOM_USERNAME_RE, chesscomDisplayName, LICHESS_USERNAME_RE } from '../profiles/sources.ts';
import { upstreamJsonWithin } from '../profiles/upstreamJson.ts';
import { searchReferencePlayers } from '../reference/index.ts';
import { likeContains } from '../stats/index.ts';

/** Shortest query (the contract's `SEARCH_QUERY_MIN_LENGTH`; the web app searches from there). */
export const MIN_QUERY_LENGTH = SEARCH_QUERY_MIN_LENGTH;
/** Longest query (`SEARCH_QUERY_MAX_LENGTH`). */
export const MAX_QUERY_LENGTH = SEARCH_QUERY_MAX_LENGTH;
/** Results per list. */
export const SEARCH_LIMIT = 10;
/** Upstream deadline (headers and body): search must feel instant, partial results beat waiting. */
export const SEARCH_UPSTREAM_TIMEOUT_MS = 3500;
/** Lichess autocomplete needs 3+ characters (shorter terms only match exactly). */
export const LICHESS_MIN_TERM = 3;

const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 500;

/** A small TTL + LRU cache of upstream answers (one per app). */
export class SearchCache {
  readonly #entries = new Map<string, { at: number; value: unknown }>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  get<T>(key: string): T | undefined {
    const e = this.#entries.get(key);
    if (!e) return undefined;
    if (this.#now() - e.at > CACHE_TTL_MS) {
      this.#entries.delete(key);
      return undefined;
    }
    this.#entries.delete(key);
    this.#entries.set(key, e);
    return e.value as T;
  }

  set(key: string, value: unknown): void {
    this.#entries.delete(key);
    this.#entries.set(key, { at: this.#now(), value });
    while (this.#entries.size > CACHE_MAX) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }
}

/** What `search` needs. */
export interface SearchDeps {
  db: Db;
  upstream: Upstream;
  cache: SearchCache;
  /** Aborts the upstream calls (the client closed the request). */
  signal?: AbortSignal;
  /** Upstream deadline (default `SEARCH_UPSTREAM_TIMEOUT_MS`; tests shorten it). */
  timeoutMs?: number;
}

interface UpstreamHit {
  username: string;
  title: Title | null;
}

const titleOf = (v: unknown): Title | null => (isTitle(v) ? v : null);

/** Lichess autocomplete; null when not applicable to `q`. Throws on upstream failure. */
async function lichessAutocomplete(deps: SearchDeps, q: string): Promise<UpstreamHit[] | null> {
  if (q.length < LICHESS_MIN_TERM || !LICHESS_USERNAME_RE.test(q)) return null;
  const key = `lichess:${playerKey(q)}`;
  const cached = deps.cache.get<UpstreamHit[]>(key);
  if (cached) return cached;
  const url = new URL(`${UPSTREAM.lichess}/api/player/autocomplete`);
  url.searchParams.set('term', q);
  url.searchParams.set('object', 'true');
  const { body } = await upstreamJsonWithin(deps.upstream, url, { timeoutMs: deps.timeoutMs ?? SEARCH_UPSTREAM_TIMEOUT_MS, signal: deps.signal });
  const result = (body as { result?: unknown } | null)?.result;
  const hits: UpstreamHit[] = [];
  for (const r of Array.isArray(result) ? (result as Array<{ id?: unknown; name?: unknown; title?: unknown } | null>) : []) {
    if (!r || typeof r !== 'object') continue;
    const name = typeof r.name === 'string' ? r.name : typeof r.id === 'string' ? r.id : null;
    if (name && LICHESS_USERNAME_RE.test(name)) hits.push({ username: name, title: titleOf(r.title) });
  }
  deps.cache.set(key, hits);
  return hits;
}

/** Chess.com exact-username check: the account, `[]` when it doesn't exist, null when not applicable. */
async function chesscomExact(deps: SearchDeps, q: string): Promise<UpstreamHit[] | null> {
  if (q.length < 3 || !CHESSCOM_USERNAME_RE.test(q)) return null;
  const lower = playerKey(q);
  const key = `chesscom:${lower}`;
  const cached = deps.cache.get<UpstreamHit[]>(key);
  if (cached) return cached;
  const res = await upstreamJsonWithin(deps.upstream, `${UPSTREAM.chesscom}/pub/player/${encodeURIComponent(lower)}`, {
    allowStatuses: [404, 410],
    timeoutMs: deps.timeoutMs ?? SEARCH_UPSTREAM_TIMEOUT_MS,
    signal: deps.signal,
  });
  let hits: UpstreamHit[] = [];
  const player = res.body as { username?: unknown; url?: unknown; title?: unknown } | null;
  if (player && typeof player === 'object' && typeof player.username === 'string') {
    hits = [{ username: chesscomDisplayName(player.url, player.username), title: titleOf(player.title) }];
  }
  deps.cache.set(key, hits);
  return hits;
}

const MAX_CODEPOINT = '\u{10FFFF}';

/**
 * SQL condition (source alias `s`): the source counts as known to the viewer — it has imported
 * games, or a profile the viewer may see shows it. Named parameters `:me`, `:admin`.
 */
const KNOWN_SOURCE = `(EXISTS (SELECT 1 FROM player_games kpg WHERE kpg.source_id = s.id)
  OR EXISTS (SELECT 1 FROM profile_sources kps JOIN profiles kp ON kp.id = kps.profile_id
              WHERE kps.source_id = s.id
                AND (kp.visibility = 'public' OR kp.owner_user_id = :me OR :admin)
                AND (kps.hidden = 0 OR kp.owner_user_id = :me OR :admin)))`;

const viewerParams = (viewer: AuthUser | null): { me: Id | null; admin: boolean } => ({ me: viewer?.id ?? null, admin: viewer?.role === 'admin' });

/** Usernames Outpost already knows for a site, by prefix (display case, best first). */
export function knownUsernames(db: Db, kind: 'lichess' | 'chesscom', q: string, viewer: AuthUser | null, limit = SEARCH_LIMIT): UpstreamHit[] {
  const prefix = playerKey(q);
  const range = [kind, prefix, `${prefix}${MAX_CODEPOINT}`, limit] as const;
  const byKey = new Map<string, UpstreamHit>();
  const add = (key: string, name: string | null, title: string | null): void => {
    const prev = byKey.get(key);
    if (!prev) byKey.set(key, { username: name && playerKey(name) === key ? name : key, title: titleOf(title) });
    else if (!prev.title && isTitle(title)) prev.title = title;
  };
  for (const r of db.all<{ key: string; display_name: string; title: string | null }>(
    `SELECT s.key, s.display_name, s.title FROM sources s
      WHERE s.kind = :kind AND s.key >= :from AND s.key < :to AND ${KNOWN_SOURCE}
      ORDER BY s.key LIMIT :limit`,
    { kind, from: range[1], to: range[2], limit, ...viewerParams(viewer) },
  )) {
    add(r.key, r.display_name, r.title);
  }
  for (const r of db.all<{ key: string; name: string | null; title: string | null }>(
    'SELECT key, name, title FROM players_cache WHERE kind = ? AND key >= ? AND key < ? ORDER BY key LIMIT ?',
    range,
  )) {
    add(r.key, r.name, r.title);
  }
  for (const r of db.all<{ opp_key: string; name: string | null; title: string | null }>(
    `SELECT k.opp_key,
            (SELECT p.opp_name FROM player_games p WHERE p.opp_source_kind = ?1 AND p.opp_key = k.opp_key LIMIT 1) AS name,
            (SELECT p.opp_title FROM player_games p WHERE p.opp_source_kind = ?1 AND p.opp_key = k.opp_key AND p.opp_title IS NOT NULL LIMIT 1) AS title
       FROM (SELECT DISTINCT opp_key FROM player_games WHERE opp_source_kind = ?1 AND opp_key >= ?2 AND opp_key < ?3 ORDER BY opp_key LIMIT ?4) k`,
    range,
  )) {
    add(r.opp_key, r.name, r.title);
  }
  return [...byKey.entries()]
    .sort(([a], [b]) => (a === prefix ? -1 : b === prefix ? 1 : a < b ? -1 : a > b ? 1 : 0))
    .slice(0, limit)
    .map(([, hit]) => hit);
}

const isKnown = (db: Db, kind: 'lichess' | 'chesscom', key: string, viewer: AuthUser | null): boolean =>
  db.value(
    `SELECT 1 WHERE EXISTS (SELECT 1 FROM sources s WHERE s.kind = :kind AND s.key = :key AND ${KNOWN_SOURCE})
        OR EXISTS (SELECT 1 FROM players_cache WHERE kind = :kind AND key = :key)
        OR EXISTS (SELECT 1 FROM player_games WHERE opp_source_kind = :kind AND opp_key = :key)`,
    { kind, key, ...viewerParams(viewer) },
  ) !== undefined;

/** Whether Outpost has synced this account successfully (so it is known to exist upstream). */
const syncedOk = (db: Db, kind: 'lichess' | 'chesscom', key: string): boolean =>
  db.value('SELECT 1 FROM sources WHERE kind = ? AND key = ? AND last_synced_at IS NOT NULL AND last_sync_error IS NULL', [kind, key]) !==
  undefined;

/**
 * The best local profile the viewer may see that includes this account (not as a hidden
 * account, unless the viewer may edit the profile), or null.
 */
export function visibleProfileSlugFor(db: Db, kind: 'lichess' | 'chesscom' | 'fide', key: string, viewer: AuthUser | null): string | null {
  return (
    db.value<string>(
      `SELECT p.slug FROM sources s
         JOIN profile_sources ps ON ps.source_id = s.id
         JOIN profiles p ON p.id = ps.profile_id
        WHERE s.kind = :kind AND s.key = :key
          AND (p.visibility = 'public' OR p.owner_user_id = :me OR :admin)
          AND (ps.hidden = 0 OR p.owner_user_id = :me OR :admin)
        ORDER BY (p.owner_user_id = :me) DESC, p.views DESC, p.id
        LIMIT 1`,
      { kind, key, me: viewer?.id ?? null, admin: viewer?.role === 'admin' },
    ) ?? null
  );
}

/** Local profiles the viewer may see matching `q` (name, address, or a visible account). */
export function searchProfiles(db: Db, q: string, viewer: AuthUser | null, limit = SEARCH_LIMIT): ProfileSummary[] {
  const ids = db
    .all<{ id: Id }>(
      `SELECT p.id FROM profiles p
        WHERE (p.visibility = 'public' OR p.owner_user_id = :me OR :admin)
          AND (p.display_name LIKE :like ESCAPE '\\' OR p.slug LIKE :likeKey ESCAPE '\\'
               OR EXISTS (
                 SELECT 1 FROM profile_sources ps
                   JOIN sources s ON s.id = ps.source_id
                   LEFT JOIN databases d ON d.id = s.database_id
                  WHERE ps.profile_id = p.id
                    AND (ps.hidden = 0 OR p.owner_user_id = :me OR :admin)
                    AND (s.database_id IS NULL OR d.kind = 'reference' OR d.visibility = 'public' OR d.owner_user_id = :me OR :admin)
                    AND (s.key LIKE :likeKey ESCAPE '\\' OR s.display_name LIKE :like ESCAPE '\\')))
        ORDER BY (lower(p.display_name) = :lower OR p.slug = :lower) DESC, (p.owner_user_id = :me) DESC, p.views DESC, p.id DESC
        LIMIT :limit`,
      {
        me: viewer?.id ?? null,
        admin: viewer?.role === 'admin',
        like: likeContains(q),
        likeKey: likeContains(playerKey(q)),
        lower: q.toLowerCase(),
        limit,
      },
    )
    .map(r => r.id);
  return profileSummaries(db, ids, viewer);
}

/**
 * How relevant a hit is, best first: the exact username, an account with a profile here, one
 * seen in imported games, a titled player (Lichess bots don't count), then the rest.
 */
export function hitRank(hit: ExternalPlayerHit, q: string): number {
  if (playerKey(hit.username) === playerKey(q)) return 0;
  if (hit.profileSlug) return 1;
  if (hit.known) return 2;
  if (hit.title && hit.title !== 'BOT') return 3;
  return 4;
}

/**
 * Merges upstream hits with local ones (one row per account), then orders them by `hitRank`,
 * keeping upstream order (then local key order) among equals, so the exact or known account isn't
 * buried under ten prefix matches from Lichess's autocomplete.
 */
function mergeHits(
  db: Db,
  kind: 'lichess' | 'chesscom',
  q: string,
  upstreamHits: readonly UpstreamHit[],
  local: readonly UpstreamHit[],
  viewer: AuthUser | null,
): ExternalPlayerHit[] {
  const confirmed = new Set(upstreamHits.map(h => playerKey(h.username)));
  const seen = new Set<string>();
  const ordered: UpstreamHit[] = [];
  for (const h of [...upstreamHits, ...local]) {
    const k = playerKey(h.username);
    if (!seen.has(k)) {
      seen.add(k);
      ordered.push(h);
    }
  }
  const hits = ordered.map((h): ExternalPlayerHit => {
    const key = playerKey(h.username);
    const localTitle = local.find(l => playerKey(l.username) === key)?.title ?? null;
    return {
      kind,
      username: h.username,
      title: h.title ?? localTitle,
      exists: confirmed.has(key) || syncedOk(db, kind, key),
      known: isKnown(db, kind, key, viewer),
      profileSlug: visibleProfileSlugFor(db, kind, key, viewer),
    };
  });
  // Array.prototype.sort is stable: equals keep the merged order.
  return hits.sort((a, b) => hitRank(a, q) - hitRank(b, q)).slice(0, SEARCH_LIMIT);
}

/** Fills `profileSlug` of reference players from local FIDE profiles the viewer may see. */
function withProfileSlugs(db: Db, players: readonly ReferencePlayer[], viewer: AuthUser | null): ReferencePlayer[] {
  return players.map(p => (p.profileSlug === null && p.fideId ? { ...p, profileSlug: visibleProfileSlugFor(db, 'fide', p.fideId, viewer) } : p));
}

/** Runs the unified search. `q` must already be trimmed and within the length limits. */
export async function search(deps: SearchDeps, q: string, viewer: AuthUser | null): Promise<SearchResults> {
  const { db } = deps;
  const [lichess, chesscom] = await Promise.allSettled([lichessAutocomplete(deps, q), chesscomExact(deps, q)]);
  const unavailable: Array<'lichess' | 'chesscom'> = [];
  if (lichess.status === 'rejected') unavailable.push('lichess');
  if (chesscom.status === 'rejected') unavailable.push('chesscom');
  // Not asked at all: `q` can't be a username there (or is too short for Lichess's autocomplete).
  const notSearched: Array<'lichess' | 'chesscom'> = [];
  if (lichess.status === 'fulfilled' && lichess.value === null) notSearched.push('lichess');
  if (chesscom.status === 'fulfilled' && chesscom.value === null) notSearched.push('chesscom');
  const upstreamOf = (r: PromiseSettledResult<UpstreamHit[] | null>): UpstreamHit[] => (r.status === 'fulfilled' && r.value ? r.value : []);
  const result: SearchResults = {
    q,
    profiles: searchProfiles(db, q, viewer),
    lichess: mergeHits(db, 'lichess', q, upstreamOf(lichess), LICHESS_USERNAME_RE.test(q) ? knownUsernames(db, 'lichess', q, viewer) : [], viewer),
    chesscom: mergeHits(db, 'chesscom', q, upstreamOf(chesscom), CHESSCOM_USERNAME_RE.test(q) ? knownUsernames(db, 'chesscom', q, viewer) : [], viewer),
    // With the viewer: admins also find name-only players of private reference databases, and
    // profileSlug counts the viewer's own private profiles.
    reference: withProfileSlugs(db, searchReferencePlayers(db, q, { limit: SEARCH_LIMIT, viewer }), viewer),
  };
  if (unavailable.length) result.unavailable = unavailable;
  if (notSearched.length) result.notSearched = notSearched;
  return result;
}
