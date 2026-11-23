/**
 * Cached broadcast reads for the routes (one instance per app): the top list (60 s), tours (30 s),
 * round previews (5 s: clients poll every 10 s, PLAN §6) and round PGNs (10 s). Concurrent
 * requests for the same key share one upstream call. Unknown tours and rounds (404) are remembered
 * for a minute; other failures are not cached.
 *
 * These calls carry the instance's Lichess token, and a 429 would put lichess.org into the shared
 * cool-down that also stalls syncs and the explorer. So cache misses draw on one instance-wide
 * budget (`BROADCAST_LIMITS.upstreamPerMinute`, like the explorer's request queue): past it the
 * routes answer 503 at once (`details.reason: 'budget'`, `retryAt`) instead of calling Lichess.
 * Every call also has a deadline covering the body (`BROADCAST_LIMITS.deadlineMs`), so a stalled
 * answer cannot hold a cache entry, and the clients waiting on it, for minutes.
 */
import type { BroadcastRound, BroadcastsResponse, BroadcastTour } from '@outpost/shared/api';
import type { Db } from '../db/index.ts';
import { HttpError, notFound, upstreamUnavailable } from '../http/errors.ts';
import type { Upstream } from '../http/upstream.ts';
import { updateFederations } from '../reference/players.ts';
import {
  fetchRound,
  fetchRoundPgn,
  fetchTopBroadcasts,
  fetchTour,
  federationsOf,
  MAX_ROUND_PGN_BYTES,
  readUpstreamText,
  roundGamePgn,
  toBroadcastRound,
  toBroadcastsResponse,
  toBroadcastSummary,
} from './lichess.ts';

/** Cache lifetimes (ms); `notFound` for unknown tours and rounds. */
export const BROADCAST_CACHE_MS = {
  list: 60_000,
  tour: 30_000,
  round: 5_000,
  pgn: 10_000,
  notFound: 60_000,
} as const;

/** Instance-wide limits of the broadcast proxy (mutable for tests). */
export const BROADCAST_LIMITS = {
  /** Upstream calls (cache misses) allowed per minute for the whole instance. */
  upstreamPerMinute: 60,
  /** Time allowed for one upstream call, body included. */
  deadlineMs: 30_000,
};

/** Most entries kept per cache by default (oldest dropped first). */
const MAX_ENTRIES = 300;
/** Round PGNs are the largest answers (up to MAX_ROUND_PGN_BYTES): keep only a few. */
const MAX_PGN_ENTRIES = 4;

const isNotFound = (e: unknown): boolean => e instanceof HttpError && e.statusCode === 404;

/**
 * A tiny TTL cache of promises (in-flight requests are shared), bounded in size. Failures are
 * dropped so the next call retries, except those `cacheError` accepts, which are kept for
 * `errorTtlMs`.
 */
export class TtlCache<T> {
  readonly #ttl: number;
  readonly #now: () => number;
  readonly #max: number;
  readonly #errorTtl: number;
  readonly #cacheError: (e: unknown) => boolean;
  readonly #entries = new Map<string, { expires: number; value: Promise<T> }>();

  constructor(ttlMs: number, opts: { now?: () => number; maxEntries?: number; errorTtlMs?: number; cacheError?: (e: unknown) => boolean } = {}) {
    this.#ttl = ttlMs;
    this.#now = opts.now ?? Date.now;
    this.#max = opts.maxEntries ?? MAX_ENTRIES;
    this.#errorTtl = opts.errorTtlMs ?? 0;
    this.#cacheError = opts.cacheError ?? (() => false);
  }

  get(key: string, load: () => Promise<T>): Promise<T> {
    const now = this.#now();
    const hit = this.#entries.get(key);
    if (hit && hit.expires > now) return hit.value;
    for (const [k, e] of this.#entries) if (e.expires <= now) this.#entries.delete(k);
    const value = load();
    const entry = { expires: Number.POSITIVE_INFINITY, value };
    this.#entries.set(key, entry);
    value.then(
      () => {
        entry.expires = this.#now() + this.#ttl;
      },
      e => {
        if (this.#errorTtl > 0 && this.#cacheError(e)) entry.expires = this.#now() + this.#errorTtl;
        else if (this.#entries.get(key) === entry) this.#entries.delete(key);
      },
    );
    while (this.#entries.size > this.#max) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
    return value;
  }

  clear(): void {
    this.#entries.clear();
  }
}

/** A sliding one-minute window of upstream calls. */
export class RequestBudget {
  readonly #now: () => number;
  readonly #limit: () => number;
  readonly #window = 60_000;
  #calls: number[] = [];

  constructor(limit: () => number, now: () => number = Date.now) {
    this.#limit = limit;
    this.#now = now;
  }

  /** Takes one call, or throws 503 `upstream_unavailable` (`reason: 'budget'`) when the minute's budget is spent. */
  take(): void {
    const now = this.#now();
    this.#calls = this.#calls.filter(t => t > now - this.#window);
    if (this.#calls.length >= this.#limit()) {
      const retryAt = this.#calls[0]! + this.#window;
      throw upstreamUnavailable('Too many broadcast requests to lichess.org right now; try again in a minute', {
        host: 'lichess.org',
        reason: 'budget',
        retryAt,
      });
    }
    this.#calls.push(now);
  }
}

/** Broadcast reads with caching, for one app. */
export class BroadcastService {
  readonly #upstream: Upstream;
  readonly #db: Db;
  readonly #now: () => number;
  readonly #budget: RequestBudget;
  readonly #list: TtlCache<BroadcastsResponse>;
  readonly #tours: TtlCache<BroadcastTour>;
  readonly #rounds: TtlCache<BroadcastRound>;
  readonly #pgns: TtlCache<string>;

  constructor(deps: { upstream: Upstream; db: Db; now?: () => number }) {
    this.#upstream = deps.upstream;
    this.#db = deps.db;
    this.#now = deps.now ?? Date.now;
    this.#budget = new RequestBudget(() => BROADCAST_LIMITS.upstreamPerMinute, this.#now);
    const notFound = { errorTtlMs: BROADCAST_CACHE_MS.notFound, cacheError: isNotFound };
    this.#list = new TtlCache(BROADCAST_CACHE_MS.list, { now: this.#now });
    this.#tours = new TtlCache(BROADCAST_CACHE_MS.tour, { now: this.#now, ...notFound });
    this.#rounds = new TtlCache(BROADCAST_CACHE_MS.round, { now: this.#now, ...notFound });
    this.#pgns = new TtlCache(BROADCAST_CACHE_MS.pgn, { now: this.#now, maxEntries: MAX_PGN_ENTRIES, ...notFound });
  }

  /** Runs one upstream call within the budget and the deadline. */
  async #call<T>(load: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.#budget.take();
    return load(AbortSignal.timeout(BROADCAST_LIMITS.deadlineMs));
  }

  /** `GET /api/broadcasts`. */
  list(): Promise<BroadcastsResponse> {
    return this.#list.get('list', () => this.#call(async signal => toBroadcastsResponse(await fetchTopBroadcasts(this.#upstream, { signal }))));
  }

  /** `GET /api/broadcasts/tour/:tourId`. */
  tour(tourId: string): Promise<BroadcastTour> {
    return this.#tours.get(tourId, () => this.#call(async signal => toBroadcastSummary(await fetchTour(this.#upstream, tourId, signal))));
  }

  /** `GET /api/broadcasts/round/:roundId`; also records the players' federations in the reference index. */
  round(roundId: string): Promise<BroadcastRound> {
    return this.#rounds.get(roundId, () =>
      this.#call(async signal => {
        const r = await fetchRound(this.#upstream, roundId, signal);
        try {
          updateFederations(this.#db, federationsOf(r));
        } catch {
          // best effort: a busy database must not fail the live view
        }
        return toBroadcastRound(r, this.#now());
      }),
    );
  }

  /** `GET /api/broadcasts/round/:roundId.pgn` (with clocks and comments, as Lichess exports it). */
  roundPgn(roundId: string): Promise<string> {
    return this.#pgns.get(roundId, () =>
      this.#call(async signal => {
        const res = await fetchRoundPgn(this.#upstream, roundId, { clocks: true, comments: true, signal });
        return readUpstreamText(res, 'round PGN', { max: MAX_ROUND_PGN_BYTES, signal });
      }),
    );
  }

  /**
   * `GET /api/broadcasts/round/:roundId/game/:gameId.pgn`: one board of the round, cut from the
   * cached round PGN (no extra upstream call), so opening a board downloads a few KB, not the
   * whole round. 404 when the round has no such game.
   */
  async gamePgn(roundId: string, gameId: string): Promise<string> {
    const game = roundGamePgn(await this.roundPgn(roundId), gameId);
    if (game === null) throw notFound('Broadcast game not found');
    return game;
  }
}
