/**
 * The `rebuild` job (JobPayloads.rebuild): recompute derived data for a source or a database —
 * the missing `player_games` rows (`rebuildPlayerGames`, e.g. after attaching a pgn/fide source to
 * games already stored) and each game's opening and `positions` rows (`reindexGames`, e.g. after
 * the chess-openings book changed). Runs on the local lane in batches, honouring cancel.
 */
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import type { Id } from '@outpost/shared/api';
import { rebuildPlayerGames, reindexGames } from '../chess/store.ts';
import type { Db } from '../db/index.ts';
import type { JobContext } from '../jobs/handlers.ts';
import { loadSource, throwIfAborted } from './common.ts';

/** Games re-indexed per transaction. */
export const REBUILD_BATCH = 200;

/** Sources whose games live in a database: its `pgn` players and the FIDE ids that appear in it. */
function databaseSourceIds(db: Db, databaseId: Id): Id[] {
  return db
    .all<{ id: Id }>(
      `SELECT id FROM sources WHERE kind = 'pgn' AND (database_id = :db OR substr(key, 1, length(:prefix)) = :prefix)
       UNION
       SELECT s.id FROM sources s WHERE s.kind = 'fide' AND s.key IN (
         SELECT white_fide_id FROM games WHERE database_id = :db AND white_fide_id IS NOT NULL
         UNION SELECT black_fide_id FROM games WHERE database_id = :db AND black_fide_id IS NOT NULL)`,
      { db: databaseId, prefix: `${databaseId}:` },
    )
    .map(r => r.id);
}

/** The `rebuild` job handler. */
export async function rebuildHandler(ctx: JobContext<'rebuild'>): Promise<void> {
  const { db, signal } = ctx;
  const { sourceId, databaseId } = ctx.job.payload;
  if (sourceId === undefined && databaseId === undefined) throw new Error('A rebuild needs a sourceId or a databaseId');

  const sources: Id[] = [];
  let gameIds: Id[] = [];
  if (sourceId !== undefined) {
    if (!loadSource(db, sourceId)) throw new Error(`Source ${sourceId} does not exist`);
    sources.push(sourceId);
  }
  if (databaseId !== undefined) {
    if (db.value('SELECT 1 FROM databases WHERE id = ?', [databaseId]) === undefined) throw new Error(`Database ${databaseId} does not exist`);
    sources.push(...databaseSourceIds(db, databaseId));
    gameIds = db.all<{ id: Id }>('SELECT id FROM games WHERE database_id = ? ORDER BY id', [databaseId]).map(r => r.id);
  }

  let added = 0;
  ctx.progress({ done: 0, total: null, message: 'Linking games to players', counts: { playerGames: 0 } });
  for (const id of [...new Set(sources)]) {
    throwIfAborted(signal);
    added += rebuildPlayerGames(db, id);
    await yieldToEventLoop();
  }
  if (sourceId !== undefined) {
    const own = db.all<{ game_id: Id }>('SELECT game_id FROM player_games WHERE source_id = ? ORDER BY game_id', [sourceId]).map(r => r.game_id);
    gameIds = [...new Set([...gameIds, ...own])];
  }

  let done = 0;
  let invalid = 0;
  for (let i = 0; i < gameIds.length; i += REBUILD_BATCH) {
    throwIfAborted(signal);
    const r = reindexGames(db, gameIds.slice(i, i + REBUILD_BATCH));
    invalid += r.invalid;
    done = Math.min(gameIds.length, i + REBUILD_BATCH);
    ctx.progress({
      done,
      total: gameIds.length,
      message: `Re-indexed ${done} of ${gameIds.length} games`,
      counts: { playerGames: added, invalid },
    });
    await yieldToEventLoop();
  }
  ctx.progress({
    done: gameIds.length,
    total: gameIds.length,
    message: `Rebuilt ${gameIds.length} game${gameIds.length === 1 ? '' : 's'}; ${added} player link${added === 1 ? '' : 's'} added`,
    counts: { playerGames: added, invalid },
  });
}
