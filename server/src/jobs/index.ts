// Persistent job queue, one worker per lane (lichess, chesscom, local), backoff and the daily
// auto-refresh scheduler — PLAN §7 (owner: jobs). Table: jobs (001_init.sql); kinds/payloads:
// JobKind/JobPayloads in @outpost/shared/api.
//
// Cross-module API (other modules import only from here):
//   - queue.ts: enqueueJob, enqueueSync, getJob, toJobInfo, queuePosition, sourceSyncStatus,
//     JOB_PRIORITY, syncDedupeKey — the only way to write to `jobs`.
//   - handlers.ts: registerJobHandler / JobContext — how profiles (pgnImport) and reference
//     (referenceImport, broadcastMonth, broadcastRound) plug in their import handlers.
// Workers and the scheduler start from routes/jobs.ts in onReady **only when
// app.config.startWorkers** (off in tests) and stop in onClose.
export {
  enqueueJob,
  enqueueSync,
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
export { getJobHandler, registerJobHandler, type JobContext, type JobHandler } from './handlers.ts';
