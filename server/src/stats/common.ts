/**
 * Shared plumbing of the stats queries: the scope every endpoint works in (a profile's visible
 * sources plus the filters) and small SQL / number helpers.
 */
import type { Id, Wdl } from '@outpost/shared/api';
import type { ProfileFilters } from '@outpost/shared/filters';
import type { Db } from '../db/index.ts';
import { playerGamesWhere, type SqlFragment } from './filterSql.ts';

/** What every stats query runs over: the viewer's sources of one profile, narrowed by the filters. */
export interface StatsScope {
  db: Db;
  /** `ViewableProfile.sourceIds` (hidden sources only for editors). */
  sourceIds: readonly Id[];
  filters: ProfileFilters;
  /** Clock for date presets and "last N days" windows (tests pin it). */
  now?: number;
}

/**
 * `player_games pg` read through its primary key `(source_id, game_id)`. Aggregates over a whole
 * profile are fastest that way (one range per source, and `games` is then visited in id order),
 * but once `sqlite_stat1` exists (`PRAGMA optimize` on close runs ANALYZE) SQLite prefers a
 * narrower secondary index plus a primary-key lookup per row, two to three times slower. The
 * name is SQLite's for the primary key of the WITHOUT ROWID table in 001_init.sql
 * (stats-perf.test.ts checks it exists).
 */
export const PLAYER_GAMES_BY_PK = 'player_games pg INDEXED BY sqlite_autoindex_player_games_1';

/**
 * `games g` through the covering index of migration 300 (termination, length and opening
 * columns only): joined per filtered game by the aggregate queries.
 */
export const GAMES_STATS_INDEX = 'games g INDEXED BY games_stats';

/** The filter WHERE expression of a scope over `player_games` aliased `alias`. */
export const scopeWhere = (s: StatsScope, alias = 'pg'): SqlFragment =>
  playerGamesWhere(s.filters, { sourceIds: s.sourceIds, alias, ...(s.now !== undefined ? { now: s.now } : {}) });

/** `SUM(...) AS w, … AS d, … AS l` over the outcome column of `alias`. */
export const wdlColumns = (alias = 'pg'): string =>
  `SUM(${alias}.outcome = 'w') AS w, SUM(${alias}.outcome = 'd') AS d, SUM(${alias}.outcome = 'l') AS l`;

/** Raw W/D/L sums from SQL (NULL over zero rows). */
export interface WdlSums {
  w: number | null;
  d: number | null;
  l: number | null;
}

/** SQL sums → `Wdl` (NULL → 0). */
export const toWdl = (r: WdlSums | undefined): Wdl => ({ w: r?.w ?? 0, d: r?.d ?? 0, l: r?.l ?? 0 });

/** Adds `b` into `a`. */
export const addWdl = (a: Wdl, b: Wdl): void => {
  a.w += b.w;
  a.d += b.d;
  a.l += b.l;
};

/** Score in [0, 1] from counts, or null without games (rounded to 4 decimals). */
export const scoreOf = (games: number, w: number, d: number): number | null =>
  games > 0 ? round((w + d / 2) / games, 4) : null;

/** Rounds to `digits` decimals. */
export const round = (x: number, digits = 1): number => {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
};

/**
 * SQL for `floor(expr / unit) * unit` that is right for negative values too (pre-1970 games):
 * `expr - ((expr % ?) + ?) % ?`. Returns the SQL and the 3 parameters to append at that point.
 */
export const floorToSql = (expr: string, unit: number): SqlFragment => ({
  sql: `(${expr} - (((${expr} % ?) + ?) % ?))`,
  params: [unit, unit, unit],
});
