/**
 * The `rebuild` job (JobPayloads.rebuild): recompute derived data for a source or a database —
 * the missing `player_games` rows (`rebuildPlayerGames`, e.g. after attaching a pgn/fide source to
 * games already stored) and each game's opening and `positions` rows (`reindexGames`, e.g. after
 * the chess-openings book changed). Runs on the local lane, honouring cancel.
 *
 * Games are walked by id in batches (keyset, never all ids in memory). The cursor is saved as the
 * job's checkpoint in the transaction of each batch, so a run that is interrupted (shutdown,
 * crash) or yields resumes after the last re-indexed game. Every `batchesPerRun` batches the job
 * yields the lane (`RequeueJob`) when another local job would be claimed before it, so PGN
 * imports and local source syncs don't wait behind a large rebuild.
 */
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import type { Id } from '@outpost/shared/api';
import { rebuildPlayerGames, reindexGames } from '../chess/store.ts';
import type { Db } from '../db/index.ts';
import { clearJobCheckpoint, loadJobCheckpoint, saveJobCheckpoint } from '../jobs/checkpoint.ts';
import { RequeueJob, type JobContext } from '../jobs/handlers.ts';
import { jobWaitingAhead } from '../jobs/queue.ts';
import { loadSource, throwIfAborted } from './common.ts';

/** Games re-indexed per transaction. */
export const REBUILD_BATCH = 200;
/** Batches between two checks whether another local job is waiting (then the rebuild yields). */
export const REBUILD_BATCHES_PER_RUN = 25;

/** Where a rebuild stopped (`job_checkpoints`). */
interface RebuildCheckpoint {
  /** Player links are done (phase 1). */
  linked: boolean;
  /** Player links added. */
  added: number;
  /** Last re-indexed game id (phase 2). */
  afterId: Id;
  /** Games re-indexed so far, and how many were found invalid. */
  done: number;
  invalid: number;
  /** Games to re-index (counted when phase 2 starts). */
  total: number;
}

/** Batch sizes (tests use small ones). */
export interface RebuildOptions {
  batchSize?: number;
  batchesPerRun?: number;
}

/**
 * Sources whose games live in a database: its `pgn` players and, for a reference database, the
 * FIDE ids that appear in it (`fide` sources link reference games only, see chess/store.ts).
 */
function databaseSourceIds(db: Db, databaseId: Id): Id[] {
  return db
    .all<{ id: Id }>(
      `SELECT id FROM sources WHERE kind = 'pgn' AND (database_id = :db OR substr(key, 1, length(:prefix)) = :prefix)
       UNION
       SELECT s.id FROM sources s WHERE s.kind = 'fide' AND s.key IN (
         SELECT white_fide_id FROM games WHERE database_id = :db AND origin = 'reference' AND white_fide_id IS NOT NULL
         UNION SELECT black_fide_id FROM games WHERE database_id = :db AND origin = 'reference' AND black_fide_id IS NOT NULL)`,
      { db: databaseId, prefix: `${databaseId}:` },
    )
    .map(r => r.id);
}

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

/** The `rebuild` job handler. */
export async function rebuildHandler(ctx: JobContext<'rebuild'>, opts: RebuildOptions = {}): Promise<void> {
  const { db, signal } = ctx;
  const jobId = ctx.job.id;
  const batchSize = Math.max(1, opts.batchSize ?? REBUILD_BATCH);
  const batchesPerRun = Math.max(1, opts.batchesPerRun ?? REBUILD_BATCHES_PER_RUN);
  const { sourceId, databaseId } = ctx.job.payload;
  if (sourceId === undefined && databaseId === undefined) throw new Error('A rebuild needs a sourceId or a databaseId');
  if (sourceId !== undefined && !loadSource(db, sourceId)) throw new Error(`Source ${sourceId} does not exist`);
  if (databaseId !== undefined && db.value('SELECT 1 FROM databases WHERE id = ?', [databaseId]) === undefined) {
    throw new Error(`Database ${databaseId} does not exist`);
  }

  const saved = loadJobCheckpoint<RebuildCheckpoint>(db, jobId);
  const cp: RebuildCheckpoint = {
    linked: saved?.linked === true,
    added: count(saved?.added),
    afterId: count(saved?.afterId),
    done: count(saved?.done),
    invalid: count(saved?.invalid),
    total: count(saved?.total),
  };
  const report = (message: string): void =>
    ctx.progress({
      done: cp.done,
      total: Math.max(cp.total, cp.done),
      message,
      counts: { playerGames: cp.added, invalid: cp.invalid },
    });

  // 1. Player links (idempotent: only missing rows are added).
  if (!cp.linked) {
    ctx.progress({ done: 0, total: null, message: 'Linking games to players', counts: { playerGames: cp.added } });
    const sources = new Set<Id>();
    if (sourceId !== undefined) sources.add(sourceId);
    if (databaseId !== undefined) for (const id of databaseSourceIds(db, databaseId)) sources.add(id);
    for (const id of sources) {
      throwIfAborted(signal);
      cp.added += rebuildPlayerGames(db, id);
      await yieldToEventLoop();
    }
    cp.linked = true;
    cp.total =
      db.value<number>(
        `SELECT COUNT(*) FROM (
           SELECT id FROM games WHERE database_id = :db
           UNION SELECT game_id FROM player_games WHERE source_id = :src)`,
        { db: databaseId ?? null, src: sourceId ?? null },
      ) ?? 0;
    saveJobCheckpoint(db, jobId, cp);
  } else {
    report(`Resuming after ${cp.done} of ${cp.total} games`);
  }

  // 2. Openings and positions, by game id. `NOT INDEXED` walks the games by rowid from the
  // cursor, so each batch reads only past the last one (the database index is by date).
  const nextIds = (after: Id): Id[] => {
    const ids = new Set<Id>();
    if (databaseId !== undefined) {
      for (const r of db.all<{ id: Id }>('SELECT id FROM games NOT INDEXED WHERE id > ? AND database_id = ? ORDER BY id LIMIT ?', [
        after,
        databaseId,
        batchSize,
      ]))
        ids.add(r.id);
    }
    if (sourceId !== undefined) {
      for (const r of db.all<{ id: Id }>(
        'SELECT game_id AS id FROM player_games WHERE source_id = ? AND game_id > ? ORDER BY game_id LIMIT ?',
        [sourceId, after, batchSize],
      ))
        ids.add(r.id);
    }
    return [...ids].sort((a, b) => a - b).slice(0, batchSize);
  };

  let batches = 0;
  for (;;) {
    throwIfAborted(signal);
    const ids = nextIds(cp.afterId);
    if (ids.length === 0) break;
    db.tx(() => {
      const r = reindexGames(db, ids);
      saveJobCheckpoint(db, jobId, { ...cp, afterId: ids.at(-1)!, done: cp.done + ids.length, invalid: cp.invalid + r.invalid });
      cp.invalid += r.invalid;
    });
    cp.afterId = ids.at(-1)!;
    cp.done += ids.length;
    report(`Re-indexed ${cp.done} of ${Math.max(cp.total, cp.done)} games`);
    await yieldToEventLoop();
    if (++batches % batchesPerRun === 0 && jobWaitingAhead(db, jobId)) {
      throw new RequeueJob(`Re-indexed ${cp.done} of ${Math.max(cp.total, cp.done)} games; yielding the lane`);
    }
  }
  clearJobCheckpoint(db, jobId);
  cp.total = cp.done;
  report(`Rebuilt ${cp.done} game${cp.done === 1 ? '' : 's'}; ${cp.added} player link${cp.added === 1 ? '' : 's'} added`);
}
