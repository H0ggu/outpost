// Persistent job queue, one worker per lane (lichess, chesscom, local), backoff and the daily auto-refresh scheduler — PLAN §7 (owner: jobs). Table: jobs (001_init.sql); kinds/payloads: JobKind/JobPayloads in @outpost/shared/api.
export {};
