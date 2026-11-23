/**
 * Job handler registry: how modules plug their work into the queue (PLAN §7).
 *
 * Each job kind has exactly one owner, which registers its handler from its route plugin
 * (plugin registration runs once per app; re-registering the same kind replaces the handler):
 *
 * | Kind | Owner | Registered in |
 * |---|---|---|
 * | `sync`, `geo`, `rebuild` | jobs | `routes/jobs.ts` (code in `sync/`) |
 * | `pgnImport` | profiles | `routes/databases.ts` |
 * | `referenceImport`, `broadcastMonth`, `broadcastRound` | reference | `routes/reference.ts` |
 *
 *   registerJobHandler('pgnImport', async ctx => { … ctx.progress({ done, total: null, message: null }) … });
 *
 * A handler is a plain async function of its `JobContext`: it must not capture an app instance
 * (the registry is process-wide, tests build many apps). Contract with the workers (jobs module):
 * - return normally → `done`; throw → the worker records the error. An `UpstreamError` with
 *   reason `rate_limited` re-queues the job at `retryAt`; network errors and 5xx are retried with
 *   exponential backoff; anything else marks the job `error`.
 * - honour `ctx.signal` (cancel, shutdown) and pass it to `ctx.upstream` calls;
 * - write in short `ctx.db.tx()` batches (the API stays responsive); very heavy parsing may move to
 *   a worker thread with its own `openDb(ctx.config.dbPath)`.
 *
 * Tests call a handler directly with `makeJobContext()` from server/test/helpers.ts.
 */
import type { FastifyBaseLogger } from 'fastify';
import type { Id, JobKind, JobLane, JobPayloads, JobProgress } from '@outpost/shared/api';
import type { Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import type { Upstream } from '../http/upstream.ts';

/** What a handler gets for one run of one job. */
export interface JobContext<K extends JobKind = JobKind> {
  job: {
    id: Id;
    kind: K;
    lane: JobLane;
    payload: JobPayloads[K];
    userId: Id | null;
    /** Runs so far including this one (1 on the first run). */
    attempts: number;
  };
  db: Db;
  config: Config;
  /** The app's shared upstream client (User-Agent, token, 429 cool-down). */
  upstream: Upstream;
  log: FastifyBaseLogger;
  /** Aborted when the job is cancelled or the server shuts down. */
  signal: AbortSignal;
  /** Records progress for the UI (the worker stores it, throttled). */
  progress(p: JobProgress): void;
}

/** A job handler. */
export type JobHandler<K extends JobKind = JobKind> = (ctx: JobContext<K>) => Promise<void>;

const handlers = new Map<JobKind, JobHandler<never>>();

/** Registers the handler for a job kind (replacing any earlier one). */
export function registerJobHandler<K extends JobKind>(kind: K, handler: JobHandler<K>): void {
  handlers.set(kind, handler as JobHandler<never>);
}

/** The handler for a kind, or undefined when its module hasn't registered one. */
export function getJobHandler<K extends JobKind>(kind: K): JobHandler<K> | undefined {
  return handlers.get(kind) as JobHandler<K> | undefined;
}
