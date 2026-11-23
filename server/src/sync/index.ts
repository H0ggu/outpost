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
import { rebuildPlayerGames } from '../chess/store.ts';
import { syncChesscom } from './chesscom.ts';
import { finishSync, loadSource, recordSyncError, type SourceRow } from './common.ts';
import { geoHandler, queueOpponentLookups } from './geo.ts';
import { syncLichess, type LichessSyncOptions } from './lichess.ts';
import { rebuildHandler } from './rebuild.ts';

export {
  archiveMonth,
  chesscomDisplayName,
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
export { rebuildHandler } from './rebuild.ts';

/** Failures that say nothing about the source (retry later, cancel, shutdown): not recorded on it. */
function isTransient(e: unknown, signal: AbortSignal): boolean {
  if (signal.aborted || e instanceof RequeueJob) return true;
  return e instanceof UpstreamError && (e.reason === 'rate_limited' || e.reason === 'aborted');
}

/** `pgn` and `fide` sources have nothing upstream: a sync links the games already stored. */
function syncLocal(ctx: JobContext<'sync'>, src: SourceRow): void {
  const added = rebuildPlayerGames(ctx.db, src.id);
  finishSync(ctx.db, src.id, null, null, Date.now());
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
        syncLocal(ctx, src);
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
  registerJobHandler('rebuild', rebuildHandler);
}
