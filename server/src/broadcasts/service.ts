/**
 * Cached broadcast reads for the routes (one instance per app): the official list (60 s), tours
 * (30 s), round previews (5 s: clients poll every 10 s, PLAN §6) and round PGNs (10 s). Concurrent
 * requests for the same key share one upstream call; failures are not cached.
 */
import type { BroadcastRound, BroadcastsResponse, BroadcastTour } from '@outpost/shared/api';
import type { Db } from '../db/index.ts';
import type { Upstream } from '../http/upstream.ts';
import { updateFederations } from '../reference/players.ts';
import {
  fetchOfficialBroadcasts,
  fetchRound,
  fetchRoundPgn,
  fetchTour,
  federationsOf,
  MAX_ROUND_PGN_BYTES,
  toBroadcastRound,
  toBroadcastsResponse,
  toBroadcastSummary,
} from './lichess.ts';

/** Cache lifetimes (ms). */
export const BROADCAST_CACHE_MS = {
  list: 60_000,
  tour: 30_000,
  round: 5_000,
  pgn: 10_000,
} as const;

/** Most entries kept per cache by default (oldest dropped first). */
const MAX_ENTRIES = 300;
/** Round PGNs can be large: keep only a few. */
const MAX_PGN_ENTRIES = 8;

/** A tiny TTL cache of promises (in-flight requests are shared), bounded in size. */
export class TtlCache<T> {
  readonly #ttl: number;
  readonly #now: () => number;
  readonly #max: number;
  readonly #entries = new Map<string, { expires: number; value: Promise<T> }>();

  constructor(ttlMs: number, opts: { now?: () => number; maxEntries?: number } = {}) {
    this.#ttl = ttlMs;
    this.#now = opts.now ?? Date.now;
    this.#max = opts.maxEntries ?? MAX_ENTRIES;
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
      () => {
        if (this.#entries.get(key) === entry) this.#entries.delete(key);
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

/** Reads text from a response, failing past `max` bytes. */
async function readText(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) {
    void res.body?.cancel().catch(() => {});
    throw new Error(`Round PGN is larger than ${max} bytes`);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of (res.body ?? []) as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > max) throw new Error(`Round PGN is larger than ${max} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Broadcast reads with caching, for one app. */
export class BroadcastService {
  readonly #upstream: Upstream;
  readonly #db: Db;
  readonly #now: () => number;
  readonly #list: TtlCache<BroadcastsResponse>;
  readonly #tours: TtlCache<BroadcastTour>;
  readonly #rounds: TtlCache<BroadcastRound>;
  readonly #pgns: TtlCache<string>;

  constructor(deps: { upstream: Upstream; db: Db; now?: () => number }) {
    this.#upstream = deps.upstream;
    this.#db = deps.db;
    this.#now = deps.now ?? Date.now;
    this.#list = new TtlCache(BROADCAST_CACHE_MS.list, { now: this.#now });
    this.#tours = new TtlCache(BROADCAST_CACHE_MS.tour, { now: this.#now });
    this.#rounds = new TtlCache(BROADCAST_CACHE_MS.round, { now: this.#now });
    this.#pgns = new TtlCache(BROADCAST_CACHE_MS.pgn, { now: this.#now, maxEntries: MAX_PGN_ENTRIES });
  }

  /** `GET /api/broadcasts`. */
  list(): Promise<BroadcastsResponse> {
    return this.#list.get('list', async () => toBroadcastsResponse(await fetchOfficialBroadcasts(this.#upstream)));
  }

  /** `GET /api/broadcasts/tour/:tourId`. */
  tour(tourId: string): Promise<BroadcastTour> {
    return this.#tours.get(tourId, async () => toBroadcastSummary(await fetchTour(this.#upstream, tourId)));
  }

  /** `GET /api/broadcasts/round/:roundId`; also records the players' federations in the reference index. */
  round(roundId: string): Promise<BroadcastRound> {
    return this.#rounds.get(roundId, async () => {
      const r = await fetchRound(this.#upstream, roundId);
      try {
        updateFederations(this.#db, federationsOf(r));
      } catch {
        // best effort: a busy database must not fail the live view
      }
      return toBroadcastRound(r, this.#now());
    });
  }

  /** `GET /api/broadcasts/round/:roundId.pgn` (with clocks and comments, as Lichess exports it). */
  roundPgn(roundId: string): Promise<string> {
    return this.#pgns.get(roundId, async () => {
      const res = await fetchRoundPgn(this.#upstream, roundId, { clocks: true, comments: true, timeoutMs: 30_000 });
      return readText(res, MAX_ROUND_PGN_BYTES);
    });
  }
}
