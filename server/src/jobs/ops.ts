/**
 * State transitions of the `jobs` table used by the workers and the admin endpoints (PLAN §7).
 * Internal to the jobs module: other modules enqueue through `queue.ts` only.
 *
 *   queued ──claim──▶ running ──▶ done | error | cancelled
 *     ▲                  │
 *     └── requeue ───────┘  (rate limit, backoff, yield, shutdown, restart)
 *
 * Every transition out of `running` is conditional on the row still being `running`, so an admin
 * cancel that lands while the handler is finishing is never overwritten.
 */
import type {
  AdminJobsPage,
  EpochMs,
  Id,
  JobInfo,
  JobKind,
  JobLane,
  JobProgress,
  JobStatus,
} from '@outpost/shared/api';
import type { Db, SqlValue } from '../db/index.ts';
import { notifyJobsQueued } from './notify.ts';
import { getJob, JOB_COLUMNS, toJobInfo, type JobRow } from './queue.ts';

/** Every job status, in display order. */
export const JOB_STATUSES = ['queued', 'running', 'done', 'error', 'cancelled'] as const satisfies readonly JobStatus[];
/** Every job kind (JobKind). */
export const JOB_KINDS = [
  'sync',
  'geo',
  'pgnImport',
  'referenceImport',
  'broadcastMonth',
  'broadcastRound',
  'rebuild',
] as const satisfies readonly JobKind[];
// Compile-time check that the lists are complete.
type Missing<A extends string, L extends readonly string[]> = Exclude<A, L[number]>;
const _complete: [Missing<JobStatus, typeof JOB_STATUSES>, Missing<JobKind, typeof JOB_KINDS>] extends [never, never] ? true : never = true;
void _complete;

/**
 * Atomically claims the next runnable job of a lane: `queued`, `run_after` reached, highest
 * priority first, then oldest. Marks it `running` and counts the attempt. Returns the claimed row.
 */
export function claimNextJob(db: Db, lane: JobLane, now: EpochMs): JobRow | null {
  return db.tx(() => {
    const row = db.get<JobRow>(
      `SELECT ${JOB_COLUMNS} FROM jobs
        WHERE lane = ? AND status = 'queued' AND (run_after IS NULL OR run_after <= ?)
        ORDER BY priority DESC, created_at, id
        LIMIT 1`,
      [lane, now],
    );
    if (!row) return null;
    const { changes } = db.run(
      "UPDATE jobs SET status = 'running', started_at = ?, finished_at = NULL, attempts = attempts + 1 WHERE id = ? AND status = 'queued'",
      [now, row.id],
    );
    if (changes === 0) return null;
    return { ...row, status: 'running', started_at: now, finished_at: null, attempts: row.attempts + 1 };
  });
}

/** Earliest `run_after` in the future among a lane's queued jobs (when to wake up next), or null. */
export function nextRunAfter(db: Db, lane: JobLane, now: EpochMs): EpochMs | null {
  return (
    db.value<EpochMs | null>("SELECT MIN(run_after) FROM jobs WHERE lane = ? AND status = 'queued' AND run_after > ?", [lane, now]) ??
    null
  );
}

/** Stores a progress snapshot (any status: the last snapshot of a finished job stays visible). */
export function saveProgress(db: Db, id: Id, progress: JobProgress): void {
  db.run('UPDATE jobs SET progress_json = ? WHERE id = ?', [JSON.stringify(progress), id]);
}

/** running → done. */
export function completeJob(db: Db, id: Id, now: EpochMs): boolean {
  return (
    db.run("UPDATE jobs SET status = 'done', finished_at = ?, error = NULL, run_after = NULL WHERE id = ? AND status = 'running'", [
      now,
      id,
    ]).changes > 0
  );
}

/** running → error. */
export function failJob(db: Db, id: Id, error: string, now: EpochMs): boolean {
  return (
    db.run("UPDATE jobs SET status = 'error', finished_at = ?, error = ?, run_after = NULL WHERE id = ? AND status = 'running'", [
      now,
      truncate(error),
      id,
    ]).changes > 0
  );
}

/** running → cancelled (after the handler stopped; the admin endpoint usually got there first). */
export function markCancelled(db: Db, id: Id, now: EpochMs): boolean {
  return (
    db.run("UPDATE jobs SET status = 'cancelled', finished_at = ?, run_after = NULL WHERE id = ? AND status = 'running'", [now, id])
      .changes > 0
  );
}

/**
 * running → queued, to run again at `runAfter` (null = as soon as the lane is free).
 * `refundAttempt` un-counts this run (rate limits, yields and shutdowns are not failures);
 * `error` keeps the reason visible while the job waits (null leaves the column unchanged).
 */
export function requeueJob(
  db: Db,
  id: Id,
  opts: { runAfter: EpochMs | null; refundAttempt: boolean; error?: string | null },
): boolean {
  const { changes } = db.run(
    `UPDATE jobs SET status = 'queued', run_after = ?, finished_at = NULL,
            attempts = CASE WHEN ? THEN MAX(attempts - 1, 0) ELSE attempts END,
            error = COALESCE(?, error)
      WHERE id = ? AND status = 'running'`,
    [opts.runAfter, opts.refundAttempt, opts.error === undefined || opts.error === null ? null : truncate(opts.error), id],
  );
  return changes > 0;
}

/**
 * At startup: jobs left `running` by a crash or kill go back to `queued` (PLAN §7). The interrupted
 * run still counts as an attempt, so a job that keeps killing the process ends in `error`.
 * Returns the number of rows changed.
 */
export function requeueStaleRunning(db: Db, maxAttempts: number, now: EpochMs): number {
  return db.tx(() => {
    const failed = db.run(
      `UPDATE jobs SET status = 'error', finished_at = ?, error = 'Interrupted by a server restart too many times'
        WHERE status = 'running' AND attempts >= ?`,
      [now, maxAttempts],
    ).changes;
    const requeued = db.run("UPDATE jobs SET status = 'queued', run_after = NULL WHERE status = 'running'").changes;
    return failed + requeued;
  });
}

/** Thrown by `retryJob` / `cancelJob` when the job's state doesn't allow it. */
export class JobStateError extends Error {
  override name = 'JobStateError';
}

/**
 * Admin cancel: a queued job is cancelled; a running one is marked cancelled at once (its
 * handler is aborted by the worker via `onCancelled`). Finished jobs throw `JobStateError`.
 * Returns null for an unknown id.
 */
export function cancelJob(db: Db, id: Id, now: EpochMs, onCancelled?: (id: Id) => void): JobInfo | null {
  const row = db.get<Pick<JobRow, 'status'>>('SELECT status FROM jobs WHERE id = ?', [id]);
  if (!row) return null;
  if (row.status !== 'queued' && row.status !== 'running') throw new JobStateError(`Job ${id} is already ${row.status}`);
  db.run("UPDATE jobs SET status = 'cancelled', finished_at = ?, run_after = NULL WHERE id = ? AND status IN ('queued', 'running')", [
    now,
    id,
  ]);
  if (row.status === 'running') onCancelled?.(id);
  return getJob(db, id);
}

/**
 * Admin retry:
 * - a finished job (done, error, cancelled) is queued again with a fresh attempt count — unless
 *   another active job with the same dedupe key exists, which is returned instead;
 * - a queued job waiting for its backoff runs as soon as its lane is free;
 * - a running job throws `JobStateError`.
 * Returns null for an unknown id.
 */
export function retryJob(db: Db, id: Id): JobInfo | null {
  const result = db.tx((): { job: JobInfo; wake: boolean } | null => {
    const row = db.get<JobRow>(`SELECT ${JOB_COLUMNS} FROM jobs WHERE id = ?`, [id]);
    if (!row) return null;
    if (row.status === 'running') throw new JobStateError(`Job ${id} is running`);
    if (row.status === 'queued') {
      db.run('UPDATE jobs SET run_after = NULL WHERE id = ?', [id]);
      return { job: getJob(db, id)!, wake: true };
    }
    if (row.dedupe_key !== null) {
      const active = db.get<JobRow>(`SELECT ${JOB_COLUMNS} FROM jobs WHERE dedupe_key = ? AND status IN ('queued', 'running')`, [
        row.dedupe_key,
      ]);
      if (active) return { job: toJobInfo(db, active), wake: false };
    }
    db.run(
      `UPDATE jobs SET status = 'queued', attempts = 0, error = NULL, progress_json = NULL, run_after = NULL,
              started_at = NULL, finished_at = NULL
        WHERE id = ?`,
      [id],
    );
    return { job: getJob(db, id)!, wake: true };
  });
  if (!result) return null;
  if (result.wake) notifyJobsQueued(db, result.job.lane);
  return result.job;
}

/** Filters and paging of the admin job list. */
export interface AdminJobsFilter {
  status?: JobStatus;
  kind?: JobKind;
  lane?: JobLane;
  page: number;
  pageSize: number;
}

/**
 * `GET /api/admin/jobs`: running first, then the queue in run order, then finished jobs newest
 * first. `counts` are per status under the kind/lane filters (the status filter picks the list).
 */
export function listAdminJobs(db: Db, f: AdminJobsFilter): AdminJobsPage {
  const where: string[] = [];
  const params: SqlValue[] = [];
  if (f.kind) {
    where.push('kind = ?');
    params.push(f.kind);
  }
  if (f.lane) {
    where.push('lane = ?');
    params.push(f.lane);
  }
  const counts = Object.fromEntries(JOB_STATUSES.map(s => [s, 0])) as Record<JobStatus, number>;
  for (const r of db.all<{ status: JobStatus; n: number }>(
    `SELECT status, COUNT(*) AS n FROM jobs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} GROUP BY status`,
    params,
  )) {
    counts[r.status] = r.n;
  }
  if (f.status) {
    where.push('status = ?');
    params.push(f.status);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.value<number>(`SELECT COUNT(*) FROM jobs ${whereSql}`, params) ?? 0;
  const rows = db.all<JobRow>(
    `SELECT ${JOB_COLUMNS} FROM jobs ${whereSql}
      ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END,
               CASE WHEN status = 'queued' THEN -priority ELSE 0 END,
               CASE WHEN status = 'queued' THEN created_at ELSE 0 END,
               COALESCE(finished_at, started_at, created_at) DESC,
               id DESC
      LIMIT ? OFFSET ?`,
    [...params, f.pageSize, (f.page - 1) * f.pageSize],
  );
  return { total, page: f.page, pageSize: f.pageSize, counts, jobs: rows.map(r => toJobInfo(db, r)) };
}

/**
 * `GET /api/jobs/mine`: queued and running jobs that are relevant to a user — the ones they
 * started, syncs of sources in profiles they own, and imports/rebuilds of databases they own.
 * Running first, then by queue order.
 */
export function listMyJobs(db: Db, userId: Id): JobInfo[] {
  const rows = db.all<JobRow>(
    `SELECT ${JOB_COLUMNS} FROM jobs j
      WHERE j.status IN ('queued', 'running')
        AND (
          j.user_id = :me
          OR (j.kind IN ('sync', 'rebuild') AND json_extract(j.payload_json, '$.sourceId') IN (
                SELECT ps.source_id FROM profile_sources ps JOIN profiles p ON p.id = ps.profile_id
                 WHERE p.owner_user_id = :me))
          OR (j.kind IN ('pgnImport', 'referenceImport', 'broadcastMonth', 'broadcastRound', 'rebuild')
              AND json_extract(j.payload_json, '$.databaseId') IN (SELECT id FROM databases WHERE owner_user_id = :me))
        )
      ORDER BY CASE j.status WHEN 'running' THEN 0 ELSE 1 END, j.priority DESC, j.created_at, j.id
      LIMIT 200`,
    { me: userId },
  );
  return rows.map(r => toJobInfo(db, r));
}

/** Deletes finished jobs older than the retention windows. Returns the number deleted. */
export function pruneFinishedJobs(db: Db, now: EpochMs, retention: { doneMs: number; errorMs: number }): number {
  return db.tx(
    () =>
      db.run("DELETE FROM jobs WHERE status IN ('done', 'cancelled') AND COALESCE(finished_at, created_at) < ?", [now - retention.doneMs])
        .changes +
      db.run("DELETE FROM jobs WHERE status = 'error' AND COALESCE(finished_at, created_at) < ?", [now - retention.errorMs]).changes,
  );
}

const truncate = (s: string, max = 2000): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
