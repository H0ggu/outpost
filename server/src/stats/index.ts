// Profile statistics queries over player_games — PLAN §6 "Stats" (owner: stats).
//
// Cross-module API (explorer and prep use these instead of their own versions):
//   - filterSql.ts: playerGamesWhere(filters, { sourceIds }) — the one implementation of
//     ProfileFilters semantics (opp buckets, line → pos_key, periods).
//   - gameRows.ts: GAME_ROW_SELECT + toGameRow (player perspective), DB_GAME_ROW_COLUMNS +
//     toDbGameRow (neutral rows for databases / reference / explorer games).
//   - games.ts: selectGameRows / latestGames (newest-first GameRow pages for any WHERE).
//   - activity.ts: activityStats(scope, tz) (by hour / weekday / grid in an IANA zone; prep uses
//     byHour and byWeekday) with tz.ts resolveTimeZone to validate the zone.
//   - openings.ts: openingsStats (opening rows per colour), pgnWriter.ts: gameToPgn.
//   - country.ts: normalizeCountry (players_cache country → ISO 3166-1 alpha-2 or null; GameRow,
//     opponents and the world map all report countries this way).
// Parse filters with parseFiltersQuery (../http/validate.ts); resolve the profile and its visible
// sources with loadProfileForViewer (../profiles/access.ts). A StatsScope is
// { db, sourceIds: profile.sourceIds, filters }.
export { likeContains, playerGamesWhere, type PlayerGamesWhereOptions, type SqlFragment } from './filterSql.ts';
export {
  DB_GAME_ROW_COLUMNS,
  GAME_ROW_SELECT,
  toDbGameRow,
  toGameRow,
  type DbGameRowRecord,
  type GameRowRecord,
} from './gameRows.ts';
export { scopeWhere, type StatsScope } from './common.ts';
export { activityStats, localActivity, recentDays } from './activity.ts';
export { behaviourStats, outcomeBreakdown } from './behaviour.ts';
export { canViewGame, loadGameForViewer } from './gameDetail.ts';
export { GAME_LIST_ORDER, GAMES_MAX_PAGE_SIZE, GAMES_PAGE_SIZE, gamesPage, latestGames, selectGameRows } from './games.ts';
export { OPENINGS_MAX_MOVES, openingsStats, type OpeningsOptions } from './openings.ts';
export { OPPONENTS_MAX_PAGE_SIZE, OPPONENTS_PAGE_SIZE, opponentsPage, profileSlugFor } from './opponents.ts';
export { currentRatings, overviewStats } from './overview.ts';
export { PGN_EXPORT_MAX, prepareProfilePgnExport, type PgnExport } from './pgnExport.ts';
export { gameToPgn, PGN_GAME_COLUMNS, type PgnGameRecord } from './pgnWriter.ts';
export { ratingAverages, ratingSeries, ratingStats } from './rating.ts';
export { resolveTimeZone } from './tz.ts';
export { normalizeCountry } from './country.ts';
export { worldMapStats } from './worldmap.ts';
