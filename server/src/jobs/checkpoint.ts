/**
 * Job checkpoints (table `job_checkpoints`, migration 201): a long handler's cursor, so a run that
 * yields its lane (`RequeueJob`) or is interrupted (shutdown, rate limit, backoff, crash) resumes
 * where it stopped instead of starting over.
 *
 *   const cp = loadJobCheckpoint<{ afterId: number }>(ctx.db, ctx.job.id);
 *   ctx.db.tx(() => { …work…; saveJobCheckpoint(ctx.db, ctx.job.id, { afterId }); });
 *
 * Save it in the transaction that stores the work it covers. The worker clears it when the job
 * finishes (done, error, cancelled) and an admin retry of a finished job starts from scratch.
 * There is no foreign key: handlers called directly in tests use job ids that have no row.
 */
import type { Id } from '@outpost/shared/api';
import type { Db } from '../db/index.ts';

/** The saved checkpoint of a job, or null. */
export function loadJobCheckpoint<T extends object>(db: Db, jobId: Id): Partial<T> | null {
  const json = db.value<string>('SELECT state_json FROM job_checkpoints WHERE job_id = ?', [jobId]);
  if (json === undefined) return null;
  try {
    const v: unknown = JSON.parse(json);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Partial<T>) : null;
  } catch {
    return null;
  }
}

/** Saves (replaces) a job's checkpoint. */
export function saveJobCheckpoint(db: Db, jobId: Id, state: object, now: number = Date.now()): void {
  db.run(
    `INSERT INTO job_checkpoints (job_id, state_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (job_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`,
    [jobId, JSON.stringify(state), now],
  );
}

/** Removes a job's checkpoint. */
export function clearJobCheckpoint(db: Db, jobId: Id): void {
  db.run('DELETE FROM job_checkpoints WHERE job_id = ?', [jobId]);
}
