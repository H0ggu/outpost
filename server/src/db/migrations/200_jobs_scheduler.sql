-- 200_jobs_scheduler: state of the jobs module's scheduler (PLAN §7, src/jobs/scheduler.ts).
--
-- One row per key, value is JSON: e.g. 'autoRefresh.lastDay' = "2026-11-23" (the UTC day of the
-- last daily auto refresh, so it runs once per day across restarts) and 'task.<name>.lastRunAt'
-- (epoch ms of a periodic task's last run: pruning, the geo lookup sweep).
CREATE TABLE job_scheduler_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT, WITHOUT ROWID;

-- Pruning finished jobs (status + age).
CREATE INDEX jobs_finished ON jobs (status, finished_at) WHERE status IN ('done', 'error', 'cancelled');
