// Lichess and Chess.com clients, game importers and opponent geo lookups — PLAN §7 (owner: jobs).
// Handlers for the 'sync', 'geo' and 'rebuild' job kinds (registered by routes/jobs.ts with
// `registerSyncHandlers`). Every upstream call goes through ctx.upstream (../http/upstream.ts:
// User-Agent, token, shared 429 cool-down); API games are mapped to NormalizedGame and stored
// with insertGame (../chess/store.ts).
//
// For other modules: `parseSourceProfile` / `readSourceProfile` read `sources.profile_json`
// (current site ratings, FIDE ratings, account state) — use them instead of parsing the JSON.
import { UpstreamError } from '../http/upstream.ts';
import { registerJobHandler, RequeueJob, type JobContext } from '../jobs/handlers.ts';
import { rebuildPlayerGamesInBatches } from '../chess/store.ts';
import type { Db } from '../db/index.ts';
import { syncChesscom } from './chesscom.ts';
import { finishSync, loadSource, parseJsonObject, recordSyncError, type SourceRow } from './common.ts';
import { geoHandler, queueOpponentLookups } from './geo.ts';
import { syncLichess, type LichessSyncOptions } from './lichess.ts';
import { rebuildHandler } from './rebuild.ts';

export {
  archiveMonth,
  chesscomDisplayName,
  chesscomMonthsToFetch,
  chesscomSnapshot,
  mapChesscomGame,
  monthOf,
  syncChesscom,
  type ChesscomGame,
  type ChesscomSyncState,
} from './chesscom.ts';
export {
  countryFromChesscom,
  countryFromLichessFlag,
  initialCutoff,
  loadSource,
  readNdjson,
  SyncError,
  type SourceRow,
} from './common.ts';
export {
  enqueuePendingLookups,
  geoHandler,
  pendingLookupCount,
  queueOpponentLookups,
  sweepPendingLookups,
} from './geo.ts';
export { lichessSnapshot, mapLichessGame, syncLichess, type LichessGame, type LichessSyncState, type LichessUser } from './lichess.ts';
export { parseSourceProfile, readSourceProfile, type SourceProfileRating, type SourceProfileSnapshot } from './profile.ts';
export { REBUILD_BATCH, REBUILD_BATCHES_PER_RUN, rebuildHandler, type RebuildOptions } from './rebuild.ts';

/** Failures that say nothing about the source (retry later, cancel, shutdown): not recorded on it. */
function isTransient(e: unknown, signal: AbortSignal): boolean {
  if (signal.aborted || e instanceof RequeueJob) return true;
  return e instanceof UpstreamError && (e.reason === 'rate_limited' || e.reason === 'aborted');
}

/**
 * What a `pgn` / `fide` source's games depend on: the change counters (`explorer_db_stats`) of its
 * database, or of the public reference databases for a FIDE player (with their ids, so a
 * visibility change counts as a change).
 */
export function localSourceVersion(db: Db, src: Pick<SourceRow, 'kind' | 'database_id'>): string {
  const rows =
    src.kind === 'pgn'
      ? db.all<{ id: number; changes: number }>(
          'SELECT d.id, COALESCE(s.changes, 0) AS changes FROM databases d LEFT JOIN explorer_db_stats s ON s.database_id = d.id WHERE d.id = ?',
          [src.database_id],
        )
      : db.all<{ id: number; changes: number }>(
          `SELECT d.id, COALESCE(s.changes, 0) AS changes FROM databases d LEFT JOIN explorer_db_stats s ON s.database_id = d.id
            WHERE d.kind = 'reference' AND d.visibility = 'public' ORDER BY d.id`,
        );
  return rows.map(r => `${r.id}.${r.changes}`).join(',');
}

/**
 * `pgn` and `fide` sources have nothing upstream: a sync links the games already stored, in
 * batches that yield to the event loop. Importers link new games to existing sources themselves,
 * so a sync with no change to the source's databases since the last one (`localSourceVersion`)
 * does nothing; a `full` sync always relinks.
 */
async function syncLocal(ctx: JobContext<'sync'>, src: SourceRow): Promise<void> {
  const version = localSourceVersion(ctx.db, src);
  const saved = parseJsonObject<{ linkedVersion: string }>(src.sync_state_json);
  if (!ctx.job.payload.full && src.last_synced_at !== null && saved?.linkedVersion === version) {
    finishSync(ctx.db, src.id, { linkedVersion: version }, null, Date.now());
    ctx.progress({ done: 0, total: 0, message: 'Up to date: no new games in the database', counts: { imported: 0 } });
    return;
  }
  const added = await rebuildPlayerGamesInBatches(ctx.db, src.id, { signal: ctx.signal });
  finishSync(ctx.db, src.id, { linkedVersion: version }, null, Date.now());
  ctx.progress({ done: added, total: added, message: `Linked ${added} game${added === 1 ? '' : 's'}`, counts: { imported: added } });
}

/** Options for running a sync directly (smoke tests): `lichess.max` caps the Lichess export. */
export interface SyncOptions {
  lichess?: LichessSyncOptions;
}

/**
 * The `sync` job handler: imports new games of one source, then queues lookups of its new
 * opponents. Lasting failures (unknown or closed account, other errors) are stored in
 * `sources.last_sync_error` before the job fails; rate limits, cancels and shutdowns are not.
 */
export async function syncHandler(ctx: JobContext<'sync'>, opts: SyncOptions = {}): Promise<void> {
  const src = loadSource(ctx.db, ctx.job.payload.sourceId);
  if (!src) {
    ctx.progress({ done: 0, total: 0, message: 'The source was removed before it could be synced' });
    return;
  }
  try {
    switch (src.kind) {
      case 'lichess':
        await syncLichess(ctx, src, opts.lichess);
        queueOpponentLookups(ctx.db, src.id, 'lichess');
        break;
      case 'chesscom':
        await syncChesscom(ctx, src);
        queueOpponentLookups(ctx.db, src.id, 'chesscom');
        break;
      default:
        await syncLocal(ctx, src);
    }
  } catch (e) {
    if (!isTransient(e, ctx.signal)) recordSyncError(ctx.db, src.id, e instanceof Error ? e.message : String(e));
    throw e;
  }
}

/** Registers the jobs module's own handlers: `sync`, `geo` and `rebuild`. */
export function registerSyncHandlers(): void {
  registerJobHandler('sync', ctx => syncHandler(ctx));
  registerJobHandler('geo', geoHandler);
  registerJobHandler('rebuild', ctx => rebuildHandler(ctx));
}
