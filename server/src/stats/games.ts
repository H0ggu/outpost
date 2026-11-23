/**
 * The games tab (`GET /api/profiles/:slug/games`) and the latest games of the overview.
 *
 * Paging picks the page's `(source_id, game_id)` keys from `player_games` alone, then joins
 * `games` and `players_cache` for those rows only, so a deep page never joins the whole profile.
 * Order: newest first (`ended_at` DESC, undated PGN games last), then game id, then source.
 */
import type { GameRow, GamesPage } from '@outpost/shared/api';
import { scopeWhere, toWdl, wdlColumns, type StatsScope, type WdlSums } from './common.ts';
import type { SqlFragment } from './filterSql.ts';
import { GAME_ROW_SELECT, toGameRow, type GameRowRecord } from './gameRows.ts';

/** Default and largest page sizes of the games list (`pageQuery(GAMES_PAGE_SIZE, GAMES_MAX_PAGE_SIZE)`). */
export const GAMES_PAGE_SIZE = 20;
export const GAMES_MAX_PAGE_SIZE = 100;

/** `ORDER BY` of every player-perspective game list (alias `pg`). */
export const GAME_LIST_ORDER = 'pg.ended_at DESC, pg.game_id DESC, pg.source_id';

/** Game rows for `where` (over `player_games pg`), newest first, one page. */
export function selectGameRows(scope: Pick<StatsScope, 'db'>, where: SqlFragment, limit: number, offset = 0): GameRow[] {
  const order = GAME_LIST_ORDER;
  const sql = `WITH page AS MATERIALIZED (
      SELECT pg.source_id, pg.game_id FROM player_games pg WHERE ${where.sql} ORDER BY ${order} LIMIT ? OFFSET ?)
    ${GAME_ROW_SELECT}
    JOIN page ON page.source_id = pg.source_id AND page.game_id = pg.game_id
    ORDER BY ${order}`;
  return scope.db.all<GameRowRecord>(sql, [...where.params, limit, offset]).map(toGameRow);
}

/** The `n` latest games of a scope. */
export const latestGames = (scope: StatsScope, n: number): GameRow[] => selectGameRows(scope, scopeWhere(scope), n);

/** One page of the games tab plus the W/D/L summary of everything that matches. */
export function gamesPage(scope: StatsScope, page: number, pageSize: number): GamesPage {
  const where = scopeWhere(scope);
  const sums = scope.db.get<WdlSums & { n: number }>(
    `SELECT COUNT(*) AS n, ${wdlColumns()} FROM player_games pg WHERE ${where.sql}`,
    where.params,
  );
  const total = sums?.n ?? 0;
  const offset = (page - 1) * pageSize;
  return {
    total,
    page,
    pageSize,
    summary: toWdl(sums),
    games: offset < total ? selectGameRows(scope, where, pageSize, offset) : [],
  };
}
