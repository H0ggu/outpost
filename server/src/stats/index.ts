// Profile statistics queries over player_games — PLAN §6 "Stats" (owner: stats).
//
// Cross-module API (explorer and prep use these instead of their own versions):
//   - filterSql.ts: playerGamesWhere(filters, { sourceIds }) — the one implementation of
//     ProfileFilters semantics (opp buckets, line → pos_key, periods).
//   - gameRows.ts: GAME_ROW_SELECT + toGameRow (player perspective), DB_GAME_ROW_COLUMNS +
//     toDbGameRow (neutral rows for databases / reference / explorer games).
// Parse filters with parseFiltersQuery (../http/validate.ts); resolve the profile and its visible
// sources with loadProfileForViewer (../profiles/access.ts).
export { likeContains, playerGamesWhere, type PlayerGamesWhereOptions, type SqlFragment } from './filterSql.ts';
export {
  DB_GAME_ROW_COLUMNS,
  GAME_ROW_SELECT,
  toDbGameRow,
  toGameRow,
  type DbGameRowRecord,
  type GameRowRecord,
} from './gameRows.ts';
