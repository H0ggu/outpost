/**
 * Row mappers for game lists, shared by the games tab and overview (stats), the explorer's
 * games-at-position list (explorer), the prep report (profiles), and database / reference game
 * lists (profiles, reference, explorer). Owner: stats.
 *
 *   const where = playerGamesWhere(filters, { sourceIds });
 *   const rows = db.all<GameRowRecord>(`${GAME_ROW_SELECT} WHERE ${where.sql} ORDER BY pg.ended_at DESC LIMIT ?`, [...where.params, 20]);
 *   const games = rows.map(toGameRow);
 *
 *   const dbRows = db.all<DbGameRowRecord>(`SELECT ${DB_GAME_ROW_COLUMNS} FROM games g WHERE g.database_id = ? …`, [id]);
 */
import type { DbGameRow, EpochMs, GameOrigin, GameResult, GameRow, Id, SourceKind, Termination, TimeClass } from '@outpost/shared/api';
import { colorFromChar, isTitle, type ColorChar, type Outcome } from '@outpost/shared/chess';

/** `SELECT … FROM player_games pg JOIN games g … LEFT JOIN players_cache pc …`; append WHERE / ORDER / LIMIT. */
export const GAME_ROW_SELECT = `SELECT pg.source_id, pg.game_id, pg.color, pg.outcome, pg.rating, pg.rating_after,
       pg.opp_name, pg.opp_key, pg.opp_rating, pg.opp_title, pg.opp_source_kind, pg.ended_at, pg.time_class, pg.rated,
       g.origin, g.url, g.result, g.termination, g.time_control, g.started_at, g.ply_count, g.eco, g.opening_name,
       g.accuracy_white, g.accuracy_black, g.event, pc.country AS opp_country
  FROM player_games pg
  JOIN games g ON g.id = pg.game_id
  LEFT JOIN players_cache pc ON pc.kind = pg.opp_source_kind AND pc.key = pg.opp_key`;

/** A row of `GAME_ROW_SELECT`. */
export interface GameRowRecord {
  source_id: Id;
  game_id: Id;
  color: ColorChar;
  outcome: Outcome;
  rating: number | null;
  rating_after: number | null;
  opp_name: string;
  opp_key: string;
  opp_rating: number | null;
  opp_title: string | null;
  opp_source_kind: SourceKind;
  ended_at: EpochMs | null;
  time_class: TimeClass;
  rated: number;
  origin: GameOrigin;
  url: string | null;
  result: GameResult;
  termination: Termination;
  time_control: string | null;
  started_at: EpochMs | null;
  ply_count: number;
  eco: string | null;
  opening_name: string | null;
  accuracy_white: number | null;
  accuracy_black: number | null;
  event: string | null;
  opp_country: string | null;
}

/** `GAME_ROW_SELECT` row → `GameRow` (the profile player's perspective). */
export function toGameRow(r: GameRowRecord): GameRow {
  const color = colorFromChar(r.color);
  return {
    id: r.game_id,
    origin: r.origin,
    url: r.url,
    sourceId: r.source_id,
    color,
    outcome: r.outcome,
    result: r.result,
    termination: r.termination,
    timeClass: r.time_class,
    timeControl: r.time_control,
    rated: r.rated === 1,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    rating: r.rating,
    ratingAfter: r.rating_after,
    opponent: {
      name: r.opp_name,
      key: r.opp_key,
      rating: r.opp_rating,
      title: isTitle(r.opp_title) ? r.opp_title : null,
      kind: r.opp_source_kind,
      country: r.opp_country,
    },
    plies: r.ply_count,
    eco: r.eco,
    openingName: r.opening_name,
    accuracy: color === 'white' ? r.accuracy_white : r.accuracy_black,
    event: r.event,
  };
}

/** Columns for `DbGameRow`, with `games` aliased as `g`. */
export const DB_GAME_ROW_COLUMNS =
  'g.id, g.origin, g.url, g.white, g.black, g.white_rating, g.black_rating, g.white_title, g.black_title, g.result, g.termination, g.time_class, g.event, g.round, g.ended_at, g.ply_count, g.eco, g.opening_name';

/** A row of `SELECT ${DB_GAME_ROW_COLUMNS} FROM games g`. */
export interface DbGameRowRecord {
  id: Id;
  origin: GameOrigin;
  url: string | null;
  white: string;
  black: string;
  white_rating: number | null;
  black_rating: number | null;
  white_title: string | null;
  black_title: string | null;
  result: GameResult;
  termination: Termination;
  time_class: TimeClass;
  event: string | null;
  round: string | null;
  ended_at: EpochMs | null;
  ply_count: number;
  eco: string | null;
  opening_name: string | null;
}

/** `games` row → `DbGameRow` (neutral perspective). */
export function toDbGameRow(r: DbGameRowRecord): DbGameRow {
  return {
    id: r.id,
    origin: r.origin,
    url: r.url,
    white: { name: r.white, rating: r.white_rating, title: isTitle(r.white_title) ? r.white_title : null },
    black: { name: r.black, rating: r.black_rating, title: isTitle(r.black_title) ? r.black_title : null },
    result: r.result,
    termination: r.termination,
    timeClass: r.time_class,
    event: r.event,
    round: r.round,
    endedAt: r.ended_at,
    plies: r.ply_count,
    eco: r.eco,
    openingName: r.opening_name,
  };
}
