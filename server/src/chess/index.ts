// Position keys, the opening classifier (lichess-org/chess-openings TSVs in server/data/openings),
// PGN helpers and the game store — PLAN §4 positions, §7 "After inserting games" (owner: jobs).
//
// Cross-module API (importers in jobs/sync, profiles/databases and reference all use these):
//   - store.ts: NormalizedGame, insertGame (the only writer of games/positions/player_games),
//     rebuildPlayerGames, relinkFideSources, pgnSourceKey; reindexGames / backfillPlayerTitle (jobs-internal repairs)
//   - replay.ts: replaySan, drawKindOf (how a draw ended, from the final position)
//   - pgn.ts: parsePgnGames (streaming), pgnToNormalizedGame (dedupe id, skip reasons)
//   - openings.ts: getOpeningBook, classifyOpening, openingAt (explorer `opening` fields)
//   - posKey.ts: posKey / posKeyOf (positions.pos_key), posKeyAfterLine (line filter, explorer)
export { positionAfterLine, posKey, posKeyAfterLine, posKeyOf } from './posKey.ts';
export {
  classifyOpening,
  DEFAULT_OPENINGS_DIR,
  getOpeningBook,
  loadOpeningBook,
  openingAt,
  type OpeningBook,
  type OpeningEntry,
  type OpeningMatch,
} from './openings.ts';
export {
  DEDUPE_PLY,
  MAX_STORED_TAGS,
  MAX_TAG_VALUE_LENGTH,
  parsePgnGames,
  pgnDateTime,
  pgnOriginId,
  pgnTimeClass,
  pgnToNormalizedGame,
  storedTags,
  terminationFromTag,
  type PgnGame,
  type PgnSkipReason,
} from './pgn.ts';
export { drawKindOf, isReplayError, replaySan, type Replay, type ReplayError } from './replay.ts';
export {
  backfillPlayerTitle,
  insertGame,
  InvalidGameError,
  pgnSourceKey,
  POSITION_MAX_PLY,
  rebuildPlayerGames,
  rebuildPlayerGamesInBatches,
  REBUILD_LINK_BATCH,
  relinkFideSources,
  reindexGames,
  type InsertGameResult,
  type NormalizedGame,
  type NormalizedPlayer,
} from './store.ts';
