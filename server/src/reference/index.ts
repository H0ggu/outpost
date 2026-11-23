// Reference (OTB/broadcast) database import from database.lichess.org .pgn.zst months or any PGN,
// plus the player index — PLAN §5, §6 (owner: reference).
//
// Import handlers ('referenceImport', 'broadcastMonth', 'broadcastRound') register with
// registerJobHandler (../jobs/handlers.ts) from routes/reference.ts, parse with parsePgnGames /
// pgnToNormalizedGame and store with insertGame (../chess/index.ts); downloads go through
// app.upstream / ctx.upstream.
import type { ReferencePlayer } from '@outpost/shared/api';
import type { Db } from '../db/index.ts';

/**
 * Reference-DB players matching a name or FIDE id prefix, best matches first. Cross-module: the
 * unified search (profiles, GET /api/search) calls it for `SearchResults.reference`.
 * TODO(reference): implement over the player index; the trivial body keeps search working meanwhile.
 */
export function searchReferencePlayers(_db: Db, _q: string, _opts: { limit?: number } = {}): ReferencePlayer[] {
  return [];
}
