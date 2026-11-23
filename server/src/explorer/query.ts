/**
 * SQL over a `GameSet` at one position: the conditions (Outpost filters + lila's restrictions) and
 * the scan that turns "every game of the set reaching the position, counted once (its first
 * occurrence, lowest ply) with the move played from there" into what the explorers answer.
 *
 * Aggregation happens in SQL (GROUP BY move, ORDER BY … LIMIT for game lists), so no per-game
 * objects are built, and the scan runs in **slices of game ids** with a yield to the event loop
 * between slices (each slice is sized to take ~`SLICE_TARGET_MS`): a reference database of a
 * million games at the start position takes a second or two of CPU, but never blocks other
 * requests for longer than a slice, and a request whose client went away stops early.
 *
 * Two plans, chosen per request from the set's size and the position's row count (forced with
 * CROSS JOIN, so no ANALYZE statistics are needed):
 * - **set-driven**: walk the set's rows (player_games by source, or `games_explorer_db` by
 *   database) and seek `positions_key (pos_key, game_id)` for each. Cost ∝ the set's size.
 * - **position-driven**: walk `positions_key` for the position and look each game up in the set.
 *   Cost ∝ the games reaching the position in the whole database (counted up to a bound).
 */
import type { Id } from '@outpost/shared/api';
import { colorChar, type Color, type ColorChar } from '@outpost/shared/chess';
import type { ExplorerRestrictions, ProfileFilters } from '@outpost/shared/filters';
import type { Db, SqlValue } from '../db/index.ts';
import { playerGamesWhere, type SqlFragment } from '../stats/filterSql.ts';
import type { GameSet } from './gameSet.ts';

/**
 * The position-driven plan is used while the position has fewer `positions` rows than this many
 * per row of the set. Measured on a million-game reference DB, a row costs about the same in both
 * plans (a sequential index step plus one seek in the other index), so the smaller side drives.
 */
export const POSITION_PLAN_FACTOR = 1;
/** Index entries counted per step while choosing a plan (a yield between steps). */
const COUNT_STEP = 200_000;
/** Aim for slices of about this long (ms) between two yields to the event loop. */
export const SLICE_TARGET_MS = 25;
/** Rows a first slice should hold before its timing is known. */
const FIRST_SLICE_ROWS = 4_000;
const MIN_SPAN = 256;

export type Plan = 'set' | 'position';

const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

const abortError = (): Error => Object.assign(new Error('The request was cancelled'), { name: 'AbortError' });

/** Yields to the event loop (other requests run between slices). */
const yieldNow = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

/**
 * WHERE expression over `pg` for a set: the Outpost filters (minus `src` for derived sets) through
 * `playerGamesWhere`, the explorer colour (which replaces the filters' `color`) and lila's
 * `speeds`/`modes`/`since`/`until` restrictions.
 */
export function setConditions(
  set: GameSet,
  filters: ProfileFilters,
  restrictions: ExplorerRestrictions,
  opts: { color: Color | null; now?: number },
): SqlFragment {
  const f: ProfileFilters = { ...filters };
  if (set.source === 'derived') delete f.src;
  if (opts.color !== null) delete f.color;
  const base = playerGamesWhere(f, { sourceIds: set.sourceIds, alias: 'pg', ...(opts.now !== undefined ? { now: opts.now } : {}) });
  const sql = [base.sql];
  const params: SqlValue[] = [...base.params];
  if (opts.color !== null) {
    sql.push('pg.color = ?');
    params.push(colorChar(opts.color));
  }
  if (restrictions.timeClasses !== null) {
    sql.push(`pg.time_class IN (${placeholders(restrictions.timeClasses.length)})`);
    params.push(...restrictions.timeClasses);
  }
  if (restrictions.rated !== null) {
    sql.push('pg.rated = ?');
    params.push(restrictions.rated ? 1 : 0);
  }
  if (restrictions.from !== null) {
    sql.push('pg.ended_at >= ?');
    params.push(restrictions.from);
  }
  if (restrictions.to !== null) {
    sql.push('pg.ended_at <= ?');
    params.push(restrictions.to);
  }
  return { sql: sql.join(' AND '), params };
}

/**
 * Number of `positions` rows for a key, counted up to `limit` (cost ∝ min(rows, limit)), in steps
 * with a yield between them (a cold index can take a while to read).
 */
export async function positionRowsUpTo(db: Db, key: number, limit: number, signal?: AbortSignal): Promise<number> {
  let n = 0;
  let after = -1;
  while (n < limit) {
    const step = Math.min(COUNT_STEP, limit - n);
    const r = db.get<{ c: number; m: number | null }>(
      'SELECT count(*) AS c, max(game_id) AS m FROM (SELECT game_id FROM positions WHERE pos_key = ? AND game_id > ? ORDER BY game_id LIMIT ?)',
      [key, after, step],
    );
    n += r?.c ?? 0;
    if (!r || r.c < step || r.m === null) break;
    after = r.m;
    await yieldNow();
    if (signal?.aborted) throw abortError();
  }
  return n;
}

/** What a scan reads: a set under conditions at a position, for one colour of the player (or both). */
export interface PositionQuery {
  set: GameSet;
  where: SqlFragment;
  key: number;
  color: Color | null;
}

/** The plan for a query, with the row estimate that sizes the first slice. */
export async function choosePlan(db: Db, q: PositionQuery, signal?: AbortSignal): Promise<{ plan: Plan; rows: number }> {
  const size = q.set.size(db);
  const limit = Math.max(1, Math.ceil(size * POSITION_PLAN_FACTOR));
  const rows = await positionRowsUpTo(db, q.key, limit, signal);
  return rows < limit ? { plan: 'position', rows } : { plan: 'set', rows: size };
}

/**
 * The hits of one slice of game ids: one row per (game, set row) — or per game with `dedupe` —
 * with the first occurrence's move (`next_uci`, NULL when the game ended there). Columns:
 * game_id, color, outcome, rating, opp_rating, ended_at, next_uci.
 */
export function hitsSql(q: PositionQuery, plan: Plan, lo: Id, hi: Id, dedupe = false): { sql: string; params: SqlValue[] } {
  const from = q.set.from(q.color);
  const cols = 'pg.game_id AS game_id, pg.color AS color, pg.outcome AS outcome, pg.rating AS rating, pg.opp_rating AS opp_rating, pg.ended_at AS ended_at';
  if (plan === 'position') {
    return {
      sql: `SELECT ${cols}, h.next_uci AS next_uci
              FROM (SELECT game_id, min(ply) AS ply, next_uci FROM positions
                     WHERE pos_key = ? AND game_id BETWEEN ? AND ? GROUP BY game_id) h
              CROSS JOIN ${from.sql}
             WHERE pg.game_id = h.game_id AND ${q.where.sql}${dedupe ? ' GROUP BY pg.game_id' : ''}`,
      params: [q.key, lo, hi, ...from.params, ...q.where.params],
    };
  }
  // min(p.ply) makes SQLite take next_uci from the first occurrence (bare column of a min() aggregate).
  return {
    sql: `SELECT ${cols}, p.next_uci AS next_uci, min(p.ply) AS ply
            FROM ${from.sql} CROSS JOIN positions p
           WHERE pg.game_id BETWEEN ? AND ? AND ${q.where.sql} AND p.pos_key = ? AND p.game_id = pg.game_id
           GROUP BY pg.game_id${dedupe ? '' : ', pg.color'}`,
    params: [...from.params, lo, hi, ...q.where.params, q.key],
  };
}

/** Per-move totals at a position (`uci` as stored: standard castling). */
export interface MoveAgg {
  uci: string;
  games: number;
  /** Absolute results. */
  white: number;
  draws: number;
  black: number;
  /** Player explorer: opponents' known ratings, and the player's score over those games. */
  oppSum: number;
  oppN: number;
  score: number;
  /** Masters shape: every known rating of both players. */
  ratingSum: number;
  ratingN: number;
  /** Latest `ended_at`, or null when no game has a date. */
  lastPlayed: number | null;
  /** The smallest game id (the game itself when `games` is 1). */
  gameId: Id;
}

/** A game of a top/recent list. */
export interface ListedHit {
  gameId: Id;
  color: ColorChar;
  /** The move played from the position, or null when the game ended there. */
  nextUci: string | null;
  endedAt: number | null;
}

/** Game lists a scan can keep. */
export type ListOrder =
  /** Highest average rating of both players first (masters `topGames`), then most recent. */
  | 'rating'
  /** Most recent first (`recentGames`, games lists). */
  | 'recent';

export interface ScanRequest {
  /** Per-move totals (`moves`, `ended`). */
  moves?: boolean;
  /** Distinct games reaching the position (`games`). */
  count?: boolean;
  /** A game list: `limit` games in `order`; `withMove`: only games with a (legal) move from the position. */
  list?: { order: ListOrder; limit: number; withMove: boolean };
  /** Moves of the set that are legal at the position (others are dropped, and their games too). */
  legal?: (uci: string) => boolean;
  /** Force a plan (tests). */
  plan?: Plan;
  /** Fixed slice width in game ids instead of the timed one (tests). */
  span?: number;
  signal?: AbortSignal;
}

export interface ScanResult {
  plan: Plan;
  /** Legal moves, unordered. */
  moves: MoveAgg[];
  /** Games whose first visit of the position was their last position. */
  ended: number;
  /** Distinct games reaching the position (with `count` or `moves`). */
  games: number;
  list: ListedHit[];
}

interface AggRow {
  uci: string | null;
  games: number;
  white: number;
  draws: number;
  opp_n: number;
  opp_sum: number;
  score: number;
  rating_n: number;
  rating_sum: number;
  last_played: number | null;
  game_id: Id;
}

const AGG_COLUMNS = `next_uci AS uci, count(*) AS games,
  sum(CASE WHEN outcome = 'd' THEN 0 WHEN (outcome = 'w') = (color = 'w') THEN 1 ELSE 0 END) AS white,
  sum(outcome = 'd') AS draws,
  sum(opp_rating IS NOT NULL) AS opp_n, total(opp_rating) AS opp_sum,
  total(CASE WHEN opp_rating IS NULL THEN 0 WHEN outcome = 'w' THEN 1 WHEN outcome = 'd' THEN 0.5 ELSE 0 END) AS score,
  sum(rating IS NOT NULL) + sum(opp_rating IS NOT NULL) AS rating_n, total(rating) + total(opp_rating) AS rating_sum,
  max(ended_at) AS last_played, min(game_id) AS game_id`;

/** ORDER BY of a list; NULL ratings and dates sort last, like the explorers always did. */
const LIST_ORDER: Record<ListOrder, string> = {
  rating: `coalesce(CASE WHEN rating IS NOT NULL AND opp_rating IS NOT NULL THEN (rating + opp_rating) / 2.0 ELSE coalesce(rating, opp_rating) END, -1e18) DESC,
           coalesce(ended_at, -1e18) DESC, game_id DESC`,
  recent: 'coalesce(ended_at, -1e18) DESC, game_id DESC',
};

/** The same order in JS (for merging slices). */
interface ListKey extends ListedHit {
  avg: number | null;
}
const listCompare = (order: ListOrder) => (a: ListKey, b: ListKey): number => {
  if (order === 'rating') {
    const d = (b.avg ?? -1e18) - (a.avg ?? -1e18);
    if (d) return d;
  }
  return (b.endedAt ?? -1e18) - (a.endedAt ?? -1e18) || b.gameId - a.gameId;
};

/**
 * Per-connection scratch table for one slice's hits, when a slice needs them more than once (moves
 * and a list): the hits are computed once, then summed and ranked from memory (`temp_store =
 * MEMORY`). A slice runs synchronously, so scans in flight never share it; it is emptied before and
 * after each use.
 */
const SLICE_TABLE = 'temp.explorer_slice_hits';
const preparedConnections = new WeakSet<Db>();
function sliceTable(db: Db): string {
  if (!preparedConnections.has(db)) {
    db.exec(`CREATE TEMP TABLE IF NOT EXISTS explorer_slice_hits (
      game_id INTEGER, color TEXT, outcome TEXT, rating INTEGER, opp_rating INTEGER, ended_at INTEGER, next_uci TEXT)`);
    preparedConnections.add(db);
  }
  return SLICE_TABLE;
}

/**
 * Scans the hits of `q` in slices of game ids. Moves are summed in SQL per slice and merged; the
 * list keeps the best `limit` rows of each slice; slices partition the games, so counts add up.
 */
export async function scanPosition(db: Db, q: PositionQuery, req: ScanRequest): Promise<ScanResult> {
  const signal = req.signal;
  const out: ScanResult = { plan: req.plan ?? 'set', moves: [], ended: 0, games: 0, list: [] };
  const range = q.set.idRange(db);
  if (!range) return out;
  const chosen = req.plan ? { plan: req.plan, rows: q.set.size(db) } : await choosePlan(db, q, signal);
  out.plan = chosen.plan;
  if (chosen.rows === 0) return out;

  // A game is one hit row (deduplicated when it can be several rows of the set).
  const multi = q.set.multiRow(q.color);
  const listLimit = req.list?.limit ?? 0;
  const consumers = (req.moves ? 1 : 0) + (req.count && !req.moves ? 1 : 0) + (listLimit > 0 ? 1 : 0);
  const moves = new Map<string, MoveAgg>();
  const illegal = new Set<string>();
  const checked = new Set<string>();
  const legal = (uci: string): boolean => {
    if (illegal.has(uci)) return false;
    if (checked.has(uci) || !req.legal) return true;
    if (req.legal(uci)) {
      checked.add(uci);
      return true;
    }
    illegal.add(uci);
    return false;
  };
  let list: ListKey[] = [];
  let ended = 0;
  let games = 0;

  const addMoves = (rows: readonly AggRow[]): void => {
    for (const r of rows) {
      games += r.games;
      if (r.uci === null) {
        ended += r.games;
        continue;
      }
      if (!legal(r.uci)) continue;
      const m = moves.get(r.uci);
      if (!m) {
        moves.set(r.uci, {
          uci: r.uci,
          games: r.games,
          white: r.white,
          draws: r.draws,
          black: r.games - r.white - r.draws,
          oppSum: r.opp_sum,
          oppN: r.opp_n,
          score: r.score,
          ratingSum: r.rating_sum,
          ratingN: r.rating_n,
          lastPlayed: r.last_played,
          gameId: r.game_id,
        });
        continue;
      }
      m.games += r.games;
      m.white += r.white;
      m.draws += r.draws;
      m.black += r.games - r.white - r.draws;
      m.oppSum += r.opp_sum;
      m.oppN += r.opp_n;
      m.score += r.score;
      m.ratingSum += r.rating_sum;
      m.ratingN += r.rating_n;
      if (r.last_played !== null && (m.lastPlayed === null || r.last_played > m.lastPlayed)) m.lastPlayed = r.last_played;
      m.gameId = Math.min(m.gameId, r.game_id);
    }
  };

  const listSql = (source: string, params: SqlValue[]): { sql: string; params: SqlValue[] } => {
    const cond: string[] = [];
    const all = [...params];
    if (req.list?.withMove) {
      cond.push('next_uci IS NOT NULL');
      if (illegal.size) {
        cond.push(`next_uci NOT IN (${placeholders(illegal.size)})`);
        all.push(...illegal);
      }
    }
    all.push(listLimit);
    return {
      sql: `SELECT game_id, color, next_uci, ended_at,
                   CASE WHEN rating IS NOT NULL AND opp_rating IS NOT NULL THEN (rating + opp_rating) / 2.0 ELSE coalesce(rating, opp_rating) END AS avg
              FROM ${source} ${cond.length ? `WHERE ${cond.join(' AND ')}` : ''}
             ORDER BY ${LIST_ORDER[req.list!.order]} LIMIT ?`,
      params: all,
    };
  };
  const addList = (rows: ReadonlyArray<{ game_id: Id; color: ColorChar; next_uci: string | null; ended_at: number | null; avg: number | null }>): void => {
    let added = 0;
    for (const r of rows) {
      // A move illegal at the position can only come from a key collision: drop its games too.
      if (req.list!.withMove && r.next_uci !== null && !legal(r.next_uci)) continue;
      list.push({ gameId: r.game_id, color: r.color, nextUci: r.next_uci, endedAt: r.ended_at, avg: r.avg });
      added++;
    }
    if (added) list = list.sort(listCompare(req.list!.order)).slice(0, listLimit);
  };
  type ListRow = { game_id: Id; color: ColorChar; next_uci: string | null; ended_at: number | null; avg: number | null };

  const slice = (lo: Id, hi: Id): void => {
    const hits = hitsSql(q, out.plan, lo, hi, multi);
    if (consumers <= 1) {
      // One use of the hits: straight from the query.
      if (req.moves) addMoves(db.all<AggRow>(`SELECT ${AGG_COLUMNS} FROM (${hits.sql}) GROUP BY next_uci`, hits.params));
      else if (req.count) games += db.value<number>(`SELECT count(*) FROM (${hits.sql})`, hits.params) ?? 0;
      else if (listLimit > 0) {
        const l = listSql(`(${hits.sql})`, hits.params);
        addList(db.all<ListRow>(l.sql, l.params));
      }
      return;
    }
    const table = sliceTable(db);
    db.run(`DELETE FROM ${table}`);
    try {
      db.run(`INSERT INTO ${table} (game_id, color, outcome, rating, opp_rating, ended_at, next_uci)
              SELECT game_id, color, outcome, rating, opp_rating, ended_at, next_uci FROM (${hits.sql})`, hits.params);
      if (req.moves) addMoves(db.all<AggRow>(`SELECT ${AGG_COLUMNS} FROM ${table} GROUP BY next_uci`));
      else if (req.count) games += db.value<number>(`SELECT count(*) FROM ${table}`) ?? 0;
      if (listLimit > 0) {
        const l = listSql(table, []);
        addList(db.all<ListRow>(l.sql, l.params));
      }
    } finally {
      db.run(`DELETE FROM ${table}`);
    }
  };

  const density = chosen.rows / Math.max(1, range.hi - range.lo + 1);
  let span = req.span ?? Math.max(MIN_SPAN, Math.ceil(FIRST_SLICE_ROWS / Math.max(density, 1e-6)));
  let lo = range.lo;
  while (lo <= range.hi) {
    if (signal?.aborted) throw abortError();
    const hi = Math.min(range.hi, lo + span - 1);
    const start = performance.now();
    slice(lo, hi);
    const ms = performance.now() - start;
    lo = hi + 1;
    if (lo > range.hi) break;
    // Next slice sized from this one's speed (growing at most 4× at a time).
    if (req.span === undefined) span = Math.max(MIN_SPAN, Math.min(span * 4, Math.round((span * SLICE_TARGET_MS) / Math.max(ms, 0.5))));
    await yieldNow();
  }
  if (signal?.aborted) throw abortError();

  out.moves = [...moves.values()];
  out.ended = ended;
  out.games = games;
  out.list = list.map(({ avg: _avg, ...hit }) => hit);
  return out;
}

/**
 * A page of the games of the set reaching the position, most recent first, in one synchronous
 * query (deep pages, beyond what a scan's list keeps). Each game appears once.
 */
export function gamesPageDirect(db: Db, q: PositionQuery, page: { offset: number; limit: number }, plan: Plan): ListedHit[] {
  const from = q.set.from(q.color);
  const chosen = plan;
  const body =
    chosen === 'position'
      ? {
          sql: `FROM positions p CROSS JOIN ${from.sql} WHERE p.pos_key = ? AND pg.game_id = p.game_id AND ${q.where.sql}`,
          params: [...from.params, q.key, ...q.where.params],
        }
      : {
          sql: `FROM ${from.sql} WHERE ${q.where.sql} AND EXISTS (SELECT 1 FROM positions p WHERE p.pos_key = ? AND p.game_id = pg.game_id)`,
          params: [...from.params, ...q.where.params, q.key],
        };
  return db
    .all<{ game_id: Id; color: ColorChar; ended_at: number | null }>(
      `SELECT pg.game_id AS game_id, pg.color AS color, pg.ended_at AS ended_at ${body.sql}
        GROUP BY pg.game_id ORDER BY coalesce(pg.ended_at, -1e18) DESC, pg.game_id DESC LIMIT ? OFFSET ?`,
      [...body.params, page.limit, page.offset],
    )
    .map(r => ({ gameId: r.game_id, color: r.color, endedAt: r.ended_at, nextUci: null }));
}
