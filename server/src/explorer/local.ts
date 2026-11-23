/**
 * The explorers over Outpost's own data (PLAN §6):
 * - `player`: `/api/explorer/player` (and `/f/<filters>/player`) — Lichess player-explorer shape;
 * - `reference`: `/api/explorer/reference` and a reference-backed `/api/explorer/masters` — masters shape;
 * - `games`: `/api/explorer/games` — the games of a player spec that reach a position.
 *
 * All three apply the same conditions (`setConditions`), so the games list matches the explorer's
 * counts (it also lists games that ended exactly at the position, which have no move to count).
 *
 * Every answer comes from one `scanPosition` (query.ts): aggregated in SQL, in slices that yield to
 * the event loop, cancelled when the client goes away. On top of that:
 * - results over whole databases (db:, ref:, the reference explorers) are cached in memory under
 *   the set's own version (`explorer_db_stats` counters), so a profile sync or an import into
 *   another database never evicts them, and identical requests in flight share one scan;
 * - scans of large sets (> `SMALL_SCAN_ROWS`) take one of `MAX_CONCURRENT_SCANS` slots (FIFO), so a
 *   burst of cold reference queries can't starve the CPU; small (profile) scans never wait.
 */
import type {
  Color,
  DbGameRow,
  ExplorerGamesPage,
  ExplorerMastersResponse,
  ExplorerPlayerResponse,
  GameRow,
  Id,
} from '@outpost/shared/api';
import { explorerQueryRestrictions, filtersKey, type ProfileFilters } from '@outpost/shared/filters';
import { getOpeningBook, type OpeningBook } from '../chess/openings.ts';
import type { Db } from '../db/index.ts';
import { HttpError } from '../http/errors.ts';
import type { AuthUser } from '../http/types.ts';
import {
  DB_GAME_ROW_COLUMNS,
  GAME_ROW_SELECT,
  toDbGameRow,
  toGameRow,
  type DbGameRowRecord,
  type GameRowRecord,
} from '../stats/gameRows.ts';
import { neutralFilters, parseSpecOrThrow, referenceGameSet, resolveGameSet, type GameSet } from './gameSet.ts';
import { Lru } from './lru.ts';
import { gamesPageDirect, scanPosition, setConditions, type ListedHit, type PositionQuery, type ScanRequest, type ScanResult } from './query.ts';
import { emptyPlayerResponse, EXPLORER_LIMITS, mastersResponse, playerResponse } from './responses.ts';
import { describeMove, normalizeFen, resolvePosition, type ExplorerPosition } from './position.ts';

/** Cached results (versioned sets only): entries, rows held (moves and listed games), lifetime. */
export const RESULT_CACHE_MAX = 500;
export const RESULT_CACHE_MAX_ROWS = 200_000;
export const RESULT_TTL_MS = 60 * 60_000;
/** Scans of sets larger than this many rows wait for one of `MAX_CONCURRENT_SCANS` slots. */
export const SMALL_SCAN_ROWS = 50_000;
export const MAX_CONCURRENT_SCANS = 2;
/** Large scans allowed to wait for a slot; more are refused with 429. */
export const MAX_QUEUED_SCANS = 64;
/** Deepest games-list position served from a scan; deeper pages use one direct query. */
export const MAX_SCANNED_LIST = 5_000;
/** Cached results with a relative period (`7d`, …) move with the clock in steps of this. */
export const PERIOD_STEP_MS = 10 * 60_000;

/** lila's explorer settings, as sent. */
export interface LilaRestrictionsInput {
  speeds?: string | undefined;
  modes?: string | undefined;
  since?: string | undefined;
  until?: string | undefined;
  /** Aborts the scan (the client went away). */
  signal?: AbortSignal | undefined;
}

/** Input of the player explorer. */
export interface PlayerExplorerInput extends LilaRestrictionsInput {
  player: string;
  color: Color;
  fen?: string | undefined;
  play?: string | undefined;
  variant?: string | undefined;
  moves?: number | undefined;
  recentGames?: number | undefined;
  filters: ProfileFilters;
  viewer: AuthUser | null;
}

/** Input of the masters-shaped reference explorer. */
export interface ReferenceExplorerInput extends LilaRestrictionsInput {
  /** One reference database (the caller checked that the viewer may read it), or null for all the viewer may read. */
  databaseId: Id | null;
  viewer: AuthUser | null;
  fen?: string | undefined;
  play?: string | undefined;
  moves?: number | undefined;
  topGames?: number | undefined;
  filters: ProfileFilters;
}

/** Input of `/api/explorer/games`. */
export interface ExplorerGamesInput extends LilaRestrictionsInput {
  player: string;
  fen?: string | undefined;
  play?: string | undefined;
  filters: ProfileFilters;
  page: number;
  pageSize: number;
  viewer: AuthUser | null;
}

/** Variants the local explorers answer (lila sends `fromPosition` games as `standard`). */
const isStandard = (variant: string | undefined): boolean =>
  variant === undefined || variant === '' || variant === 'standard' || variant === 'fromPosition';

const clamp = (v: number | undefined, def: number, max: number): number =>
  v === undefined || !Number.isFinite(v) ? def : Math.max(0, Math.min(max, Math.floor(v)));

/** The local explorers (one per app). */
export interface LocalExplorer {
  player(input: PlayerExplorerInput): Promise<ExplorerPlayerResponse>;
  reference(input: ReferenceExplorerInput): Promise<ExplorerMastersResponse>;
  games(input: ExplorerGamesInput): Promise<ExplorerGamesPage>;
  /** Drops cached results (tests, or after an import). */
  clearCache(): void;
  /** Cached results (and the rows they hold), scans in flight and waiting for a slot (tests, admin). */
  stats(): { cached: number; cachedRows: number; inFlight: number; running: number; queued: number };
}

/** Rows a cached result holds (its weight in the result cache). */
const resultRows = (v: unknown): number => {
  const r = v as { moves?: unknown[]; list?: unknown[]; topGames?: unknown[]; recentGames?: unknown[] };
  return 1 + (r.moves?.length ?? 0) + (r.list?.length ?? 0) + (r.topGames?.length ?? 0) + (r.recentGames?.length ?? 0);
};

/** The error a cancelled scan ends with (the client is gone; nothing is logged as a failure). */
const cancelled = (): HttpError => new HttpError(499, 'bad_request', 'The request was cancelled');
const isAbort = (e: unknown): boolean => e instanceof Error && e.name === 'AbortError';

interface Flight {
  promise: Promise<unknown>;
  controller: AbortController;
  waiters: number;
}

/** FIFO slots for large scans. */
class ScanGate {
  running = 0;
  readonly max: number;
  readonly maxQueue: number;
  readonly #queue: Array<{ grant: () => void; signal: AbortSignal; onAbort: () => void }> = [];
  constructor(max: number, maxQueue: number) {
    this.max = max;
    this.maxQueue = maxQueue;
  }

  get queued(): number {
    return this.#queue.length;
  }

  /** Resolves with a release function once a slot is free. */
  enter(signal: AbortSignal): Promise<() => void> {
    const release = (): void => {
      this.running--;
      const next = this.#queue.shift();
      if (next) {
        next.signal.removeEventListener('abort', next.onAbort);
        this.running++;
        next.grant();
      }
    };
    if (this.running < this.max) {
      this.running++;
      return Promise.resolve(release);
    }
    if (this.#queue.length >= this.maxQueue) {
      return Promise.reject(new HttpError(429, 'rate_limited', 'The explorer is busy with large queries; try again shortly', { reason: 'busy' }));
    }
    return new Promise((resolve, reject) => {
      const entry = {
        signal,
        grant: () => resolve(release),
        onAbort: () => {
          const i = this.#queue.indexOf(entry);
          if (i >= 0) this.#queue.splice(i, 1);
          reject(cancelled());
        },
      };
      if (signal.aborted) {
        reject(cancelled());
        return;
      }
      signal.addEventListener('abort', entry.onAbort, { once: true });
      this.#queue.push(entry);
    });
  }
}

export function createLocalExplorer(deps: {
  db: Db;
  openingsDir: string;
  now?: () => number;
  /** Slots for large scans (default `MAX_CONCURRENT_SCANS`) and the size above which a scan needs one. */
  maxConcurrentScans?: number;
  smallScanRows?: number;
}): LocalExplorer {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  let book: OpeningBook | null = null;
  const openings = (): OpeningBook => (book ??= getOpeningBook(deps.openingsDir));
  const results = new Lru<unknown>({ max: RESULT_CACHE_MAX, ttlMs: RESULT_TTL_MS, now, weigh: resultRows, maxWeight: RESULT_CACHE_MAX_ROWS });
  const flights = new Map<string, Flight>();
  const gate = new ScanGate(deps.maxConcurrentScans ?? MAX_CONCURRENT_SCANS, MAX_QUEUED_SCANS);
  const smallScanRows = deps.smallScanRows ?? SMALL_SCAN_ROWS;

  /** Joins a flight; leaving aborts it once nobody waits any more. */
  const join = <T>(key: string, flight: Flight, signal: AbortSignal | undefined): Promise<T> => {
    flight.waiters++;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const leave = (): boolean => {
        if (settled) return false;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        flight.waiters--;
        return true;
      };
      const onAbort = (): void => {
        if (!leave()) return;
        if (flight.waiters === 0) {
          flight.controller.abort();
          if (flights.get(key) === flight) flights.delete(key);
        }
        reject(cancelled());
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      flight.promise.then(
        v => {
          if (leave()) resolve(v as T);
        },
        (e: unknown) => {
          if (leave()) reject(isAbort(e) ? cancelled() : e);
        },
      );
    });
  };

  /**
   * One result per (set, version, parts): from the cache (versioned sets), from a scan in flight,
   * or computed now (through the gate when the set is large).
   */
  const shared = <T>(set: GameSet, parts: unknown[], signal: AbortSignal | undefined, compute: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const version = set.version(db);
    const key = JSON.stringify([set.cacheKey, version, ...parts]);
    if (version !== null) {
      const hit = results.get(key) as T | undefined;
      if (hit !== undefined) return Promise.resolve(hit);
    }
    let flight = flights.get(key);
    if (!flight) {
      const controller = new AbortController();
      const run = async (): Promise<T> => {
        const release = set.size(db) > smallScanRows ? await gate.enter(controller.signal) : null;
        try {
          const value = await compute(controller.signal);
          if (version !== null) results.set(key, value);
          return value;
        } finally {
          release?.();
        }
      };
      const f: Flight = { controller, waiters: 0, promise: run() };
      const done = (): void => {
        if (flights.get(key) === f) flights.delete(key);
      };
      f.promise.then(done, done);
      flights.set(key, f);
      flight = f;
    }
    return join<T>(key, flight, signal);
  };

  /**
   * The clock for the conditions, and its cache-key part: a relative period is resolved against a
   * clock rounded to `PERIOD_STEP_MS` for cached (versioned) sets, so their results stay reusable.
   */
  const clockFor = (set: GameSet, filters: ProfileFilters): { now: number; part: number | null } => {
    const t = now();
    if (filters.period === undefined || set.version(db) === null) return { now: t, part: null };
    const step = Math.floor(t / PERIOD_STEP_MS) * PERIOD_STEP_MS;
    return { now: step, part: step };
  };

  const restrictionsOf = (q: LilaRestrictionsInput) =>
    explorerQueryRestrictions({ speeds: q.speeds, modes: q.modes, since: q.since, until: q.until });

  /** Legality of stored moves at the position (a move illegal there can only come from a key collision). */
  const legalAt = (position: ExplorerPosition) => (uci: string) => describeMove(position.pos, uci, openings()) !== null;

  const scan = (q: PositionQuery, req: ScanRequest): Promise<ScanResult> => scanPosition(db, q, req);

  return {
    player(input) {
      const set = resolveGameSet(db, parseSpecOrThrow(input.player), input.viewer);
      if (!isStandard(input.variant)) return Promise.resolve(emptyPlayerResponse(null));
      const position = resolvePosition(input.fen, input.play, openings());
      const restrictions = restrictionsOf(input);
      const moves = clamp(input.moves, EXPLORER_LIMITS.defaultMoves, EXPLORER_LIMITS.maxMoves);
      const recentGames = clamp(input.recentGames, EXPLORER_LIMITS.defaultRecentGames, EXPLORER_LIMITS.maxRecentGames);
      const clock = clockFor(set, input.filters);
      const parts = ['player', input.color, normalizeFen(input.fen ?? ''), position.line.join(','), filtersKey(input.filters), clock.part, restrictions, moves, recentGames];
      return shared(set, parts, input.signal, async signal => {
        const where = setConditions(set, input.filters, restrictions, { color: input.color, now: clock.now });
        const r = await scan(
          { set, where, key: position.key, color: input.color },
          { moves: true, list: { order: 'recent', limit: recentGames, withMove: true }, legal: legalAt(position), signal },
        );
        return playerResponse(db, openings(), position, r, { moves, recentGames });
      });
    },

    reference(input) {
      const set = referenceGameSet(db, input.databaseId, input.viewer);
      const position = resolvePosition(input.fen, input.play, openings());
      const filters = neutralFilters(input.filters);
      const restrictions = restrictionsOf(input);
      const moves = clamp(input.moves, EXPLORER_LIMITS.defaultMoves, EXPLORER_LIMITS.maxMoves);
      const topGames = clamp(input.topGames, EXPLORER_LIMITS.defaultTopGames, EXPLORER_LIMITS.maxTopGames);
      const clock = clockFor(set, filters);
      const parts = ['reference', normalizeFen(input.fen ?? ''), position.line.join(','), filtersKey(filters), clock.part, restrictions, moves, topGames];
      return shared(set, parts, input.signal, async signal => {
        const where = setConditions(set, filters, restrictions, { color: null, now: clock.now });
        const r = await scan(
          { set, where, key: position.key, color: null },
          { moves: true, list: { order: 'rating', limit: topGames, withMove: true }, legal: legalAt(position), signal },
        );
        return mastersResponse(db, openings(), position, r, { moves, topGames });
      });
    },

    games(input) {
      const set = resolveGameSet(db, parseSpecOrThrow(input.player), input.viewer);
      const position = resolvePosition(input.fen, input.play, openings());
      const restrictions = restrictionsOf(input);
      const filters = { ...input.filters };
      // A database has no player: its "colour" only picks the side the other filters refer to.
      const color: Color | null = set.spec.kind === 'db' ? (filters.color ?? 'white') : (filters.color ?? null);
      const offset = (input.page - 1) * input.pageSize;
      const want = offset + input.pageSize;
      const clock = clockFor(set, filters);
      const parts = ['games', normalizeFen(input.fen ?? ''), position.line.join(','), filtersKey(filters), clock.part, restrictions, color];
      const q = (): PositionQuery => ({
        set,
        where: setConditions(set, filters, restrictions, { color: null, now: clock.now }),
        key: position.key,
        color,
      });
      const page = async (): Promise<{ total: number; hits: ListedHit[] }> => {
        if (want <= MAX_SCANNED_LIST) {
          // The scan keeps the newest games up to the next multiple of 100, so neighbouring pages share it.
          const keep = Math.min(MAX_SCANNED_LIST, Math.ceil(want / 100) * 100);
          const r = await shared(set, [...parts, keep], input.signal, signal =>
            scan(q(), { count: true, list: { order: 'recent', limit: keep, withMove: false }, signal }),
          );
          return { total: r.games, hits: r.list.slice(offset, want) };
        }
        const counted = await shared(set, [...parts, 0], input.signal, signal => scan(q(), { count: true, signal }));
        const total = counted.games;
        return { total, hits: offset >= total ? [] : gamesPageDirect(db, q(), { offset, limit: input.pageSize }, counted.plan) };
      };
      return page().then(({ total, hits }) => {
        const paging = { total, page: input.page, pageSize: input.pageSize };
        if (set.perspective === 'player') return { ...paging, perspective: 'player' as const, games: playerRows(db, set, hits) };
        return { ...paging, perspective: 'neutral' as const, games: neutralRows(db, hits) };
      });
    },

    clearCache: () => results.clear(),
    stats: () => ({ cached: results.size, cachedRows: results.weight, inFlight: flights.size, running: gate.running, queued: gate.queued }),
  };
}

/** `GameRow`s for hits of a player_games set, in hit order. */
function playerRows(db: Db, set: GameSet, hits: readonly ListedHit[]): GameRow[] {
  const out: GameRow[] = [];
  for (const h of hits) {
    const r = db.get<GameRowRecord>(
      `${GAME_ROW_SELECT} WHERE pg.game_id = ? AND pg.color = ? AND pg.source_id IN (${set.sourceIds.map(() => '?').join(', ')}) LIMIT 1`,
      [h.gameId, h.color, ...set.sourceIds],
    );
    if (r) out.push(toGameRow(r));
  }
  return out;
}

/** `DbGameRow`s for hits, in hit order. */
function neutralRows(db: Db, hits: readonly ListedHit[]): DbGameRow[] {
  if (hits.length === 0) return [];
  const rows = db.all<DbGameRowRecord>(
    `SELECT ${DB_GAME_ROW_COLUMNS} FROM games g WHERE g.id IN (${hits.map(() => '?').join(', ')})`,
    hits.map(h => h.gameId),
  );
  const byId = new Map(rows.map(r => [r.id, r]));
  return hits.map(h => byId.get(h.gameId)).filter((r): r is DbGameRowRecord => r !== undefined).map(toDbGameRow);
}
