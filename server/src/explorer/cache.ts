/**
 * The explorer's upstream response cache, stored in `http_cache` (PLAN §4) under keys prefixed
 * `ex:<kind>:`. Freshness is per kind (and shorter for "not found" answers); stale entries are kept
 * a while longer so they can be served when the upstream is down or rate-limiting (stale-if-error),
 * and revalidated with `If-None-Match` when the upstream sent an ETag. Expired rows are pruned
 * opportunistically on writes.
 */
import type { Db } from '../db/index.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Cached upstream kinds and their lifetimes. */
export const CACHE_POLICY = {
  /** explorer.lichess.org/masters (Lichess sends max-age=10800). */
  masters: { ttlMs: 3 * HOUR, missTtlMs: 3 * HOUR, staleMs: 7 * DAY },
  /** explorer.lichess.org/lichess (needs the token). */
  lichess: { ttlMs: 3 * HOUR, missTtlMs: 3 * HOUR, staleMs: 7 * DAY },
  /** explorer.lichess.org/masters/pgn/:id (Lichess caches it 30 days). */
  'masters-pgn': { ttlMs: 30 * DAY, missTtlMs: DAY, staleMs: 30 * DAY },
  /** tablebase.lichess.ovh: results never change. */
  tablebase: { ttlMs: 30 * DAY, missTtlMs: DAY, staleMs: 30 * DAY },
  /** lichess.org/api/cloud-eval: evaluations appear and deepen over time. */
  'cloud-eval': { ttlMs: 30 * MIN, missTtlMs: 10 * MIN, staleMs: DAY },
} as const;

/** A cached kind. */
export type CacheKind = keyof typeof CACHE_POLICY;

/** One cached upstream answer. */
export interface CacheEntry {
  status: number;
  body: string;
  contentType: string;
  fetchedAt: number;
  etag: string | null;
}

/** How fresh an entry is. */
export type Freshness = 'fresh' | 'stale' | 'expired';

const PRUNE_EVERY_MS = 10 * MIN;

/** Cache key for a kind and its normalised request. */
export const cacheKey = (kind: CacheKind, request: string): string => `ex:${kind}:${request}`;

/** Freshness of an entry of `kind` at `now`. */
export function freshness(kind: CacheKind, e: Pick<CacheEntry, 'status' | 'fetchedAt'>, now: number): Freshness {
  const p = CACHE_POLICY[kind];
  const age = now - e.fetchedAt;
  const ttl = e.status === 200 ? p.ttlMs : p.missTtlMs;
  if (age < ttl) return 'fresh';
  return age < ttl + p.staleMs ? 'stale' : 'expired';
}

/** `http_cache` access for the explorer kinds. */
export class ExplorerCache {
  readonly #db: Db;
  readonly #now: () => number;
  #lastPrune = 0;

  constructor(db: Db, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  get(key: string): CacheEntry | null {
    const row = this.#db.get<{ body: string | Uint8Array; content_type: string; fetched_at: number; etag: string | null; status: number }>(
      'SELECT body, content_type, fetched_at, etag, status FROM http_cache WHERE key = ?',
      [key],
    );
    if (!row) return null;
    const body = typeof row.body === 'string' ? row.body : new TextDecoder().decode(row.body);
    return { status: row.status, body, contentType: row.content_type, fetchedAt: row.fetched_at, etag: row.etag };
  }

  put(key: string, e: Omit<CacheEntry, 'fetchedAt'>): void {
    const now = this.#now();
    this.#db.run(
      `INSERT INTO http_cache (key, body, content_type, fetched_at, etag, status) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET body = excluded.body, content_type = excluded.content_type,
         fetched_at = excluded.fetched_at, etag = excluded.etag, status = excluded.status`,
      [key, e.body, e.contentType, now, e.etag, e.status],
    );
    if (now - this.#lastPrune > PRUNE_EVERY_MS) this.prune();
  }

  /** Marks an entry as just revalidated (a 304). */
  touch(key: string): void {
    this.#db.run('UPDATE http_cache SET fetched_at = ? WHERE key = ?', [this.#now(), key]);
  }

  /** Deletes the explorer entries that are past their stale window. Returns the number removed. */
  prune(): number {
    const now = this.#now();
    this.#lastPrune = now;
    let removed = 0;
    for (const [kind, p] of Object.entries(CACHE_POLICY)) {
      const prefix = cacheKey(kind as CacheKind, '');
      // Keys sort between `ex:<kind>:` and `ex:<kind>;` (';' follows ':').
      const upper = `${prefix.slice(0, -1)};`;
      removed += this.#db.run(
        `DELETE FROM http_cache WHERE key >= ? AND key < ?
           AND fetched_at < ? - (CASE WHEN status = 200 THEN ? ELSE ? END) - ?`,
        [prefix, upper, now, p.ttlMs, p.missTtlMs, p.staleMs],
      ).changes;
    }
    return removed;
  }
}
