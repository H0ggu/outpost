// Reference (OTB/broadcast) databases — PLAN §0.5, §5 (Ultra/Masters DB, FIDE player pages), §6
// (owner: reference). Routes in routes/reference.ts; migration 600_reference.sql.
//
// - Imports run as jobs ('broadcastMonth', 'referenceImport', 'broadcastRound', ./jobs.ts):
//   bytes → zstd/gzip (node:zlib) → parsePgnGames → toReferenceGame → insertGame (./importer.ts),
//   deduplicated by content hash (games.origin_id) and Lichess study chapter.
// - Reference databases (./databases.ts): the built-in "Lichess broadcasts" DB (CC BY-SA 4.0, created
//   on first import) and admin-named ones; attribution lines for the UI.
// - The player index (./players.ts): FIDE ids, names, titles, federations, game counts.
// - Auto-import of finished broadcast rounds (./autoImport.ts), only with config.startWorkers and
//   the admin setting `broadcastAutoImport`.
//
// Cross-module API: `searchReferencePlayers` (unified search), `referencePlayerByFideId` (FIDE
// profiles / `fide` source syncs), `foldName`.
export {
  BROADCAST_DATABASE,
  broadcastDatabaseId,
  ensureBroadcastDatabase,
  LICHESS_BROADCAST_ATTRIBUTION,
  listReferenceDatabases,
  referenceAttribution,
} from './databases.ts';
export { foldName, referencePlayerByFideId, searchReferencePlayers } from './players.ts';
