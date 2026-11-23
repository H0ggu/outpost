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
 * Upstream calls go through `app.upstream` with short timeouts; a failure leaves that site's
 * upstream hits out (local hits stay) and lists the site in `unavailable`. Answers are cached
 * per app for a minute so typing doesn't hammer Lichess / Chess.com.
 */
import type { ExternalPlayerHit, Id, ProfileSummary, ReferencePlayer, SearchResults, Title } from '@outpost/shared/api';
import { isTitle, playerKey } from '@outpost/shared/chess';
import type { Db } from '../db/index.ts';
import type { AuthUser } from '../http/types.ts';
import { UPSTREAM, type Upstream } from '../http/upstream.ts';
import { CHESSCOM_USERNAME_RE, LICHESS_USERNAME_RE } from '../profiles/sources.ts';
import { profileSummaries } from '../profiles/service.ts';
import { searchReferencePlayers } from '../reference/index.ts';
import { likeContains } from '../stats/index.ts';

/** Shortest query (the web app searches from 2 characters). */
export const MIN_QUERY_LENGTH = 2;
/** Longest query. */
export const MAX_QUERY_LENGTH = 100;
/** Results per list. */
export const SEARCH_LIMIT = 10;
/** Upstream timeout: search must feel instant, partial results beat waiting. */
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
  const body = await deps.upstream.json<{ result?: Array<{ id?: unknown; name?: unknown; title?: unknown }> }>(url, {
    timeoutMs: SEARCH_UPSTREAM_TIMEOUT_MS,
  });
  const hits: UpstreamHit[] = [];
  for (const r of Array.isArray(body?.result) ? body.result : []) {
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
  const res = await deps.upstream.fetch(`${UPSTREAM.chesscom}/pub/player/${encodeURIComponent(lower)}`, {
    allowStatuses: [404, 410],
    timeoutMs: SEARCH_UPSTREAM_TIMEOUT_MS,
    headers: { accept: 'application/json' },
  });
  let hits: UpstreamHit[] = [];
  if (res.status === 200) {
    const player = (await res.json()) as { username?: unknown; url?: unknown; title?: unknown } | null;
    if (player && typeof player.username === 'string') {
      const fromUrl = typeof player.url === 'string' ? /\/member\/([^/?#]+)$/.exec(player.url)?.[1] : undefined;
      const display = fromUrl ? decodeURIComponent(fromUrl) : player.username;
      hits = [{ username: playerKey(display) === lower ? display : player.username, title: titleOf(player.title) }];
    }
  } else void res.body?.cancel().catch(() => {});
  deps.cache.set(key, hits);
  return hits;
}

const MAX_CODEPOINT = '\u{10FFFF}';

/** Usernames Outpost already knows for a site, by prefix (display case, best first). */
export function knownUsernames(db: Db, kind: 'lichess' | 'chesscom', q: string, limit = SEARCH_LIMIT): UpstreamHit[] {
  const prefix = playerKey(q);
  const range = [kind, prefix, `${prefix}${MAX_CODEPOINT}`, limit] as const;
  const byKey = new Map<string, UpstreamHit>();
  const add = (key: string, name: string | null, title: string | null): void => {
    const prev = byKey.get(key);
    if (!prev) byKey.set(key, { username: name && playerKey(name) === key ? name : key, title: titleOf(title) });
    else if (!prev.title && isTitle(title)) prev.title = title;
  };
  for (const r of db.all<{ key: string; display_name: string; title: string | null }>(
    'SELECT key, display_name, title FROM sources WHERE kind = ? AND key >= ? AND key < ? ORDER BY key LIMIT ?',
    range,
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

const isKnown = (db: Db, kind: 'lichess' | 'chesscom', key: string): boolean =>
  db.value(
    `SELECT 1 WHERE EXISTS (SELECT 1 FROM sources WHERE kind = ?1 AND key = ?2)
        OR EXISTS (SELECT 1 FROM players_cache WHERE kind = ?1 AND key = ?2)
        OR EXISTS (SELECT 1 FROM player_games WHERE opp_source_kind = ?1 AND opp_key = ?2)`,
    [kind, key],
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

/** Merges upstream hits (first, in upstream order, exact match on top) with local ones. */
function mergeHits(
  db: Db,
  kind: 'lichess' | 'chesscom',
  q: string,
  upstreamHits: readonly UpstreamHit[],
  local: readonly UpstreamHit[],
  viewer: AuthUser | null,
): ExternalPlayerHit[] {
  const exact = playerKey(q);
  const confirmed = new Set(upstreamHits.map(h => playerKey(h.username)));
  const seen = new Set<string>();
  const ordered: UpstreamHit[] = [];
  for (const h of [...upstreamHits].sort((a, b) => Number(playerKey(b.username) === exact) - Number(playerKey(a.username) === exact))) {
    const k = playerKey(h.username);
    if (!seen.has(k)) {
      seen.add(k);
      ordered.push(h);
    }
  }
  for (const h of local) {
    const k = playerKey(h.username);
    if (!seen.has(k)) {
      seen.add(k);
      ordered.push(h);
    }
  }
  return ordered.slice(0, SEARCH_LIMIT).map(h => {
    const key = playerKey(h.username);
    const localTitle = local.find(l => playerKey(l.username) === key)?.title ?? null;
    return {
      kind,
      username: h.username,
      title: h.title ?? localTitle,
      exists: confirmed.has(key) || syncedOk(db, kind, key),
      known: isKnown(db, kind, key),
      profileSlug: visibleProfileSlugFor(db, kind, key, viewer),
    };
  });
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
  const upstreamOf = (r: PromiseSettledResult<UpstreamHit[] | null>): UpstreamHit[] => (r.status === 'fulfilled' && r.value ? r.value : []);
  const result: SearchResults = {
    q,
    profiles: searchProfiles(db, q, viewer),
    lichess: mergeHits(db, 'lichess', q, upstreamOf(lichess), LICHESS_USERNAME_RE.test(q) ? knownUsernames(db, 'lichess', q) : [], viewer),
    chesscom: mergeHits(db, 'chesscom', q, upstreamOf(chesscom), CHESSCOM_USERNAME_RE.test(q) ? knownUsernames(db, 'chesscom', q) : [], viewer),
    reference: withProfileSlugs(db, searchReferencePlayers(db, q, { limit: SEARCH_LIMIT }), viewer),
  };
  if (unavailable.length) result.unavailable = unavailable;
  return result;
}
