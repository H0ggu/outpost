/**
 * In-process "work is available" notifications (PLAN §7): `enqueueJob` and admin retries call
 * `notifyJobsQueued`, and the lane workers of the same database wake up instead of polling.
 * Keyed by `Db` so the many apps that tests build never wake each other's workers.
 */
import type { JobLane } from '@outpost/shared/api';
import type { Db } from '../db/index.ts';

type Listener = (lane: JobLane) => void;

const listeners = new WeakMap<Db, Set<Listener>>();

/** Subscribes to new or re-queued work on `db`. Returns the unsubscribe function. */
export function onJobsQueued(db: Db, fn: Listener): () => void {
  let set = listeners.get(db);
  if (!set) {
    set = new Set();
    listeners.set(db, set);
  }
  set.add(fn);
  return () => {
    set.delete(fn);
  };
}

/** Tells this database's workers that `lane` has work. Listeners must not throw or block. */
export function notifyJobsQueued(db: Db, lane: JobLane): void {
  const set = listeners.get(db);
  if (!set) return;
  for (const fn of [...set]) {
    try {
      fn(lane);
    } catch {
      // a broken listener must not break enqueueing
    }
  }
}
