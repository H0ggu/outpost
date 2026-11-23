-- 201_job_checkpoints: where a long job stopped (src/jobs/checkpoint.ts).
--
-- A handler that yields its lane (RequeueJob) or is interrupted (shutdown, rate limit, backoff,
-- crash) saves its cursor here in the same transaction as the work it covers, and resumes from it
-- on its next run (e.g. the `rebuild` job's last re-indexed game id). Cleared when the job
-- finishes or is retried from scratch; rows of deleted jobs are pruned with them.
CREATE TABLE job_checkpoints (
  job_id     INTEGER PRIMARY KEY,
  state_json TEXT    NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
