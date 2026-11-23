// Persistent job queue, one worker per lane (lichess, chesscom, local), backoff and the daily
// auto-refresh scheduler — PLAN §7 (owner: jobs). Table: jobs (001_init.sql); kinds/payloads:
// JobKind/JobPayloads in @outpost/shared/api.
//
// Cross-module API (other modules import only from here):
//   - queue.ts: enqueueJob, enqueueSync, getJob, toJobInfo, queuePosition, sourceSyncStatus,
//     JOB_PRIORITY, syncDedupeKey — the only way to write to `jobs`.
//   - handlers.ts: registerJobHandler / JobContext — how profiles (pgnImport) and reference
//     (referenceImport, broadcastMonth, broadcastRound) plug in their import handlers;
//     RequeueJob lets a long handler yield its lane.
// Internal to the jobs module: ops.ts (state transitions, admin lists), worker.ts (JobRunner),
// scheduler.ts (Scheduler), notify.ts (wake-up on enqueue).
// Workers and the scheduler start from routes/jobs.ts in onReady **only when
// app.config.startWorkers** (off in tests) and stop in onClose.
export {
  enqueueJob,
  enqueueSync,
  geoDedupeKey,
  getJob,
  JOB_COLUMNS,
  JOB_PRIORITY,
  jobLabel,
  laneFor,
  queuePosition,
  sourceSyncStatus,
  syncDedupeKey,
  toJobInfo,
  type EnqueueOptions,
  type JobRow,
} from './queue.ts';
export { getJobHandler, registerJobHandler, RequeueJob, type JobContext, type JobHandler } from './handlers.ts';
export { notifyJobsQueued, onJobsQueued } from './notify.ts';
export {
  cancelJob,
  claimNextJob,
  JOB_KINDS,
  JOB_STATUSES,
  JobStateError,
  listAdminJobs,
  listMyJobs,
  pruneFinishedJobs,
  requeueStaleRunning,
  retryJob,
  type AdminJobsFilter,
} from './ops.ts';
export {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  backoffDelay,
  isRetryableError,
  JOB_LANES,
  JobAbortedError,
  JobRunner,
  MAX_JOB_ATTEMPTS,
  type JobRunnerOptions,
} from './worker.ts';
export {
  autoRefreshSourceIds,
  JOB_RETENTION,
  readSchedulerState,
  runAutoRefreshIfDue,
  Scheduler,
  utcDay,
  writeSchedulerState,
  type ScheduledTask,
  type SchedulerOptions,
} from './scheduler.ts';
