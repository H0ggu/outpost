/**
 * `ProfileFilters` → SQL over `player_games` (PLAN §6 "Common filter query").
 *
 * The single implementation of the filter semantics, used by every stats endpoint, the player
 * explorer and `/api/explorer/games` (explorer), and the prep report (profiles). Owner: stats;
 * other modules call it and never re-implement a filter.
 *
 *   const where = playerGamesWhere(filters, { sourceIds: profile.sourceIds });
 *   db.all(`SELECT … FROM player_games pg WHERE ${where.sql}`, where.params);
 *
 * Semantics:
 * - `sourceIds` are the profile's sources visible to the viewer; `src` narrows them (ids outside
 *   the profile are ignored, so an empty intersection matches nothing).
 * - `color`, `tc`, `rated`, `outcome`: columns of player_games (the player's side).
 * - `period` / `from` / `to`: `ended_at` within `resolveDateRange(filters, now)` (UTC days);
 *   games without a date are excluded when a date filter is set.
 * - `opp`: (opponent rating − player's pre-game rating) within `oppStrengthRange`; games without
 *   both ratings are excluded.
 * - `oppName`: case-insensitive substring of the opponent's name or key; `event`: substring of
 *   `games.event`.
 * - `line`: the game reached the position after the line at any ply ≤ 50 (`positions.pos_key`,
 *   so transpositions count). An illegal line is a 400 `validation` error.
 */
import type { Id } from '@outpost/shared/api';
import { colorChar, playerKey } from '@outpost/shared/chess';
import { oppStrengthRange, resolveDateRange, type ProfileFilters } from '@outpost/shared/filters';
import { posKeyAfterLine } from '../chess/posKey.ts';
import type { SqlValue } from '../db/index.ts';
import { validationError } from '../http/errors.ts';

/** A boolean SQL expression (no `WHERE`) and its positional parameters. */
export interface SqlFragment {
  sql: string;
  params: SqlValue[];
}

/** Options of `playerGamesWhere`. */
export interface PlayerGamesWhereOptions {
  /** The profile's sources visible to the viewer (`ViewableProfile.sourceIds`). */
  sourceIds: readonly Id[];
  /** Clock for `period` presets (tests pin it). */
  now?: number;
  /** Alias of `player_games` in the caller's query (default `pg`). */
  alias?: string;
}

/** Escapes `%`, `_` and `\` for `LIKE … ESCAPE '\'`. */
export const likeContains = (s: string): string => `%${s.replace(/[\\%_]/g, c => `\\${c}`)}%`;

const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

/** Builds the WHERE expression for `filters` over `player_games` (see the module comment). */
export function playerGamesWhere(filters: ProfileFilters, opts: PlayerGamesWhereOptions): SqlFragment {
  const a = opts.alias ?? 'pg';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(a)) throw new Error(`Invalid SQL alias: ${a}`);
  const where: string[] = [];
  const params: SqlValue[] = [];

  const sources = filters.src?.length ? opts.sourceIds.filter(id => filters.src!.includes(id)) : [...opts.sourceIds];
  if (sources.length === 0) return { sql: '0', params: [] };
  where.push(`${a}.source_id IN (${placeholders(sources.length)})`);
  params.push(...sources);

  if (filters.color) {
    where.push(`${a}.color = ?`);
    params.push(colorChar(filters.color));
  }

  const range = resolveDateRange(filters, opts.now ?? Date.now());
  if (range.from !== null) {
    where.push(`${a}.ended_at >= ?`);
    params.push(range.from);
  }
  if (range.to !== null) {
    where.push(`${a}.ended_at <= ?`);
    params.push(range.to);
  }

  if (filters.tc?.length) {
    where.push(`${a}.time_class IN (${placeholders(filters.tc.length)})`);
    params.push(...filters.tc);
  }
  if (filters.rated) {
    where.push(`${a}.rated = ?`);
    params.push(filters.rated === 'rated' ? 1 : 0);
  }
  if (filters.outcome?.length) {
    where.push(`${a}.outcome IN (${placeholders(filters.outcome.length)})`);
    params.push(...filters.outcome);
  }

  if (filters.opp) {
    const { minDiff, maxDiff } = oppStrengthRange(filters.opp);
    where.push(`${a}.rating IS NOT NULL AND ${a}.opp_rating IS NOT NULL`);
    if (minDiff !== null) {
      where.push(`${a}.opp_rating - ${a}.rating >= ?`);
      params.push(minDiff);
    }
    if (maxDiff !== null) {
      where.push(`${a}.opp_rating - ${a}.rating <= ?`);
      params.push(maxDiff);
    }
  }

  if (filters.oppName) {
    where.push(`(${a}.opp_key LIKE ? ESCAPE '\\' OR ${a}.opp_name LIKE ? ESCAPE '\\')`);
    params.push(likeContains(playerKey(filters.oppName)), likeContains(filters.oppName));
  }
  if (filters.event) {
    where.push(`EXISTS (SELECT 1 FROM games f_ev WHERE f_ev.id = ${a}.game_id AND f_ev.event LIKE ? ESCAPE '\\')`);
    params.push(likeContains(filters.event));
  }
  if (filters.line?.length) {
    const key = posKeyAfterLine(filters.line);
    if (key === null) throw validationError('line: not a legal sequence of moves from the start position');
    where.push(`EXISTS (SELECT 1 FROM positions f_ln WHERE f_ln.pos_key = ? AND f_ln.game_id = ${a}.game_id)`);
    params.push(key);
  }

  return { sql: where.join(' AND '), params };
}
