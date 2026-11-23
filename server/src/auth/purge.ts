/**
 * Background purge of deleted users (`DELETE /api/admin/users/:id`, see src/auth/admin.ts).
 *
 * `beginUserDeletion` (admin.ts) marks the user (`users.deleting_at`), disables them, signs them out
 * and removes their small rows in one short transaction. What remains can be huge: their personal
 * games databases, whose games cascade to `positions` (~50 rows per game) and `player_games`.
 * Deleting that in one transaction would block the event loop (node:sqlite is synchronous) and hold
 * the write lock for many seconds, so this purger removes it in batches of `PURGE_BATCH_GAMES`
 * games, one short transaction each, yielding to the event loop between batches. The user row is
 * deleted last (its remaining FKs cascade or SET NULL as documented in admin.ts).
 *
 * One user is purged at a time. A purge interrupted by a shutdown or an error resumes on the next
 * start (`resumePending`, from the admin plugin's onReady) or when an admin deletes the user again.
 */
import type { FastifyBaseLogger } from 'fastify';
import type { Id } from '@outpost/shared/api';
import type { Db } from '../db/index.ts';

/** Games deleted per transaction (each with up to 51 positions and its player_games rows). */
export const PURGE_BATCH_GAMES = 200;
/** Pause before retrying after an error (e.g. the database stayed busy past its timeout). */
export const PURGE_RETRY_MS = 10_000;
/** Attempts per scheduled purge before giving up until the next start or delete request. */
export const PURGE_MAX_ATTEMPTS = 5;

/** The purger of one app. */
export interface UserPurger {
  /**
   * Queues the purge of a user already marked by `beginUserDeletion`. Resolves true once the user
   * row is gone, false when the purge stopped early (shutdown, repeated errors). Never rejects.
   */
  schedule(userId: Id): Promise<boolean>;
  /** Schedules every user still marked for deletion (after a restart). */
  resumePending(): void;
  /** Stops after the current batch; resolves when nothing runs any more. */
  close(): Promise<void>;
}

const nextTick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

/** Creates the purger. `batchSize` and `pause` are for tests. */
export function createUserPurger(deps: {
  db: Db;
  log: FastifyBaseLogger;
  batchSize?: number;
  pause?: () => Promise<void>;
  retryMs?: number;
}): UserPurger {
  const { db, log } = deps;
  const batchSize = deps.batchSize ?? PURGE_BATCH_GAMES;
  const pause = deps.pause ?? nextTick;
  const retryMs = deps.retryMs ?? PURGE_RETRY_MS;
  const pending = new Map<Id, Promise<boolean>>();
  let chain: Promise<unknown> = Promise.resolve();
  let closed = false;
  let wake: (() => void) | null = null;

  const sleep = (ms: number): Promise<void> =>
    new Promise(resolve => {
      const timer = setTimeout(() => {
        wake = null;
        resolve();
      }, ms);
      timer.unref();
      wake = () => {
        clearTimeout(timer);
        wake = null;
        resolve();
      };
    });

  /** One pass over a user's data. Returns true when the user row is gone. */
  const purgeOnce = async (userId: Id): Promise<boolean> => {
    for (;;) {
      if (closed) return false;
      const databaseId = db.value<number>(
        "SELECT id FROM databases WHERE owner_user_id = ? AND kind = 'games' ORDER BY id LIMIT 1",
        [userId],
      );
      if (databaseId === undefined) break;
      for (;;) {
        if (closed) return false;
        const removed = db.tx(
          () =>
            db.run('DELETE FROM games WHERE id IN (SELECT id FROM games WHERE database_id = ? LIMIT ?)', [databaseId, batchSize])
              .changes,
        );
        if (removed === 0) break;
        await pause();
      }
      // Its pgn sources (and anything a concurrent import just added) cascade from here.
      db.tx(() => db.run('DELETE FROM databases WHERE id = ?', [databaseId]));
      await pause();
    }
    if (closed) return false;
    db.tx(() => db.run('DELETE FROM users WHERE id = ? AND deleting_at IS NOT NULL', [userId]));
    return true;
  };

  const purge = async (userId: Id): Promise<boolean> => {
    for (let attempt = 1; attempt <= PURGE_MAX_ATTEMPTS; attempt++) {
      if (closed) return false;
      try {
        const done = await purgeOnce(userId);
        if (done) log.info({ userId }, 'deleted user purged');
        return done;
      } catch (err) {
        log.warn({ err, userId, attempt }, 'could not purge a deleted user; retrying');
        if (attempt < PURGE_MAX_ATTEMPTS) await sleep(retryMs);
      }
    }
    log.error({ userId }, 'giving up purging a deleted user until the next start (or delete them again)');
    return false;
  };

  return {
    schedule(userId) {
      const existing = pending.get(userId);
      if (existing) return existing;
      const run = chain.then(() => purge(userId)).finally(() => pending.delete(userId));
      pending.set(userId, run);
      chain = run.catch(() => false);
      return run;
    },
    resumePending() {
      for (const { id } of db.all<{ id: Id }>('SELECT id FROM users WHERE deleting_at IS NOT NULL ORDER BY deleting_at')) {
        void this.schedule(id);
      }
    },
    async close() {
      closed = true;
      wake?.();
      await Promise.allSettled([...pending.values()]);
    },
  };
}
