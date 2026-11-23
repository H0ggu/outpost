// Reference (OTB/broadcast) databases — PLAN §0.5, §5 (Ultra/Masters DB, FIDE player pages), §6
// (owner: reference). Routes in routes/reference.ts; migration 600_reference.sql.
//
// - Imports run as jobs ('broadcastMonth', 'referenceImport', 'broadcastRound', ./jobs.ts):
//   bytes → zstd/gzip (node:zlib) → splitPgnGames → parsePgnGames → toReferenceGame → insertGame
//   (./importer.ts), deduplicated by content hash (games.origin_id) and Lichess study chapter; a
//   later monthly dump replaces a chapter's game when it was corrected meanwhile.
// - FIDE profiles (`fide` sources) get reference games only, once per game across reference
//   databases (triggers in migration 601).
// - Reference databases (./databases.ts): the built-in "Lichess broadcasts" DB (CC BY-SA 4.0, created
//   on first import) and admin-named ones; attribution lines for the UI.
// - The player index (./players.ts): FIDE ids, names, titles, federations, game counts; a FIDE
//   player's federation is also their country in `players_cache` (kind `fide`, ./federations.ts).
// - Auto-import of finished broadcast rounds (./autoImport.ts), only with config.startWorkers and
//   the admin setting `broadcastAutoImport`.
//
// Cross-module API: `searchReferencePlayers(db, q, { limit, viewer })` (unified search: pass the
// viewer, or private reference databases' players stay hidden and only public profiles link),
// `referencePlayerByFideId` (FIDE profiles / `fide` source syncs), `foldName`.
export {
  BROADCAST_DATABASE,
  broadcastDatabaseId,
  ensureBroadcastDatabase,
  LICHESS_BROADCAST_ATTRIBUTION,
  listReferenceDatabases,
  referenceAttribution,
} from './databases.ts';
export { federationCountry } from './federations.ts';
export { foldName, referencePlayerByFideId, searchReferencePlayers } from './players.ts';
