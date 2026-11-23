/**
 * SQL over a `GameSet` at one position: the conditions (Outpost filters + lila's restrictions) and
 * the "hits" — every game of the set that reaches the position, counted once (its first
 * occurrence, lowest ply) with the move played from there.
 *
 * Two plans, picked per request (forced with CROSS JOIN, so no ANALYZE statistics are needed):
 * - **set-driven**: walk the set's rows (player_games by source, or games by database) and seek
 *   `positions_key (pos_key, game_id)` for each. Cost ∝ the set's size; used for common positions.
 * - **position-driven**: walk `positions_key` for the position and look each game up in the set.
 *   Cost ∝ the games reaching the position in the whole database; used for rare positions.
 */
import type { Id } from '@outpost/shared/api';
import { colorChar, type Color, type ColorChar, type Outcome } from '@outpost/shared/chess';
import type { ExplorerRestrictions, ProfileFilters } from '@outpost/shared/filters';
import type { Db, SqlValue } from '../db/index.ts';
import { playerGamesWhere, type SqlFragment } from '../stats/filterSql.ts';
import type { GameSet } from './gameSet.ts';

/** Below this many `positions` rows for a key, the position-driven plan is used. */
export const RARE_POSITION_ROWS = 2000;

/** One game of the set at the position. */
export interface Hit {
  gameId: Id;
  /** The player's colour in this row (White for neutral sets). */
  color: ColorChar;
  /** From `color`'s side. */
  outcome: Outcome;
  rating: number | null;
  oppRating: number | null;
  endedAt: number | null;
  /** Ply of the first occurrence of the position in the game. */
  ply: number;
  /** Move played from the position (standard castling), or null when the game ended there. */
  nextUci: string | null;
}

/** Absolute winner of a hit. */
export const hitWinner = (h: Hit): Color | null =>
  h.outcome === 'd' ? null : (h.outcome === 'w') === (h.color === 'w') ? 'white' : 'black';

const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

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

interface HitRow {
  game_id: Id;
  color: ColorChar;
  outcome: Outcome;
  rating: number | null;
  opp_rating: number | null;
  ended_at: number | null;
  ply: number;
  next_uci: string | null;
}

const HIT_COLUMNS = 'pg.game_id, pg.color, pg.outcome, pg.rating, pg.opp_rating, pg.ended_at, p.ply, p.next_uci';

/** Number of `positions` rows for a key, counted up to `limit` (cheap either way). */
export function positionRowsUpTo(db: Db, key: number, limit: number): number {
  return db.value<number>('SELECT count(*) FROM (SELECT 1 FROM positions WHERE pos_key = ? LIMIT ?)', [key, limit]) ?? 0;
}

/** The plan `collectHits` would use (exposed for tests and EXPLAIN checks). */
export function hitsQuery(
  db: Db,
  set: GameSet,
  where: SqlFragment,
  key: number,
  color: Color | null,
  plan?: 'set' | 'position',
): { plan: 'set' | 'position'; sql: string; params: SqlValue[] } {
  const chosen = plan ?? (positionRowsUpTo(db, key, RARE_POSITION_ROWS) < RARE_POSITION_ROWS ? 'position' : 'set');
  const from = set.from(color);
  if (chosen === 'set') {
    return {
      plan: chosen,
      sql: `SELECT ${HIT_COLUMNS} FROM ${from.sql} CROSS JOIN positions p
             WHERE ${where.sql} AND p.pos_key = ? AND p.game_id = pg.game_id`,
      params: [...from.params, ...where.params, key],
    };
  }
  return {
    plan: chosen,
    sql: `SELECT ${HIT_COLUMNS} FROM positions p CROSS JOIN ${from.sql}
           WHERE p.pos_key = ? AND pg.game_id = p.game_id AND ${where.sql}`,
    params: [...from.params, key, ...where.params],
  };
}

/** One game of a games-at-position page. */
export interface PageHit {
  gameId: Id;
  color: ColorChar;
  endedAt: number | null;
}

/**
 * A page of the games of the set that reach the position (most recent first), counted in SQL so
 * large sets never come into memory. Each game appears once.
 */
export function gamesAtPosition(
  db: Db,
  set: GameSet,
  where: SqlFragment,
  key: number,
  color: Color | null,
  page: { offset: number; limit: number },
  plan?: 'set' | 'position',
): { total: number; hits: PageHit[] } {
  const from = set.from(color);
  const rare = plan ? plan === 'position' : positionRowsUpTo(db, key, RARE_POSITION_ROWS) < RARE_POSITION_ROWS;
  const body = rare
    ? {
        sql: `FROM positions p CROSS JOIN ${from.sql} WHERE p.pos_key = ? AND pg.game_id = p.game_id AND ${where.sql}`,
        params: [...from.params, key, ...where.params],
      }
    : {
        sql: `FROM ${from.sql} WHERE ${where.sql} AND EXISTS (SELECT 1 FROM positions p WHERE p.pos_key = ? AND p.game_id = pg.game_id)`,
        params: [...from.params, ...where.params, key],
      };
  const total = db.value<number>(`SELECT count(DISTINCT pg.game_id) ${body.sql}`, body.params) ?? 0;
  const rows = db.all<{ game_id: Id; color: ColorChar; ended_at: number | null }>(
    `SELECT pg.game_id AS game_id, pg.color AS color, pg.ended_at AS ended_at ${body.sql}
      GROUP BY pg.game_id ORDER BY pg.ended_at DESC, pg.game_id DESC LIMIT ? OFFSET ?`,
    [...body.params, page.limit, page.offset],
  );
  return { total, hits: rows.map(r => ({ gameId: r.game_id, color: r.color, endedAt: r.ended_at })) };
}

/**
 * Every game of the set reaching the position, once per game (first occurrence). A game listed
 * twice in the set (two of a profile's accounts played each other, uncoloured queries) keeps the
 * first row seen.
 */
export function collectHits(
  db: Db,
  set: GameSet,
  where: SqlFragment,
  key: number,
  color: Color | null,
  plan?: 'set' | 'position',
): Hit[] {
  const q = hitsQuery(db, set, where, key, color, plan);
  const byGame = new Map<Id, Hit>();
  for (const r of db.iterate<HitRow>(q.sql, q.params)) {
    const prev = byGame.get(r.game_id);
    if (prev && (prev.ply <= r.ply || prev.color !== r.color)) continue;
    byGame.set(r.game_id, {
      gameId: r.game_id,
      color: r.color,
      outcome: r.outcome,
      rating: r.rating,
      oppRating: r.opp_rating,
      endedAt: r.ended_at,
      ply: r.ply,
      nextUci: r.next_uci,
    });
  }
  return [...byGame.values()];
}
