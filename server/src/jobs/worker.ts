/**
 * The job workers (PLAN §7): one in-process worker per lane — `lichess` and `chesscom` (one
 * upstream request in flight per site) and `local` (PGN and reference imports, rebuilds).
 *
 * Each worker loops: atomically claim the lane's next job (queued, `run_after` reached, priority
 * DESC then oldest), run its registered handler with a `JobContext`, then record the outcome:
 * - success → `done`;
 * - `UpstreamError('rate_limited')` → back to `queued` until `retryAt` (≥ 60 s; not a failure);
 * - network errors, timeouts, 5xx → back to `queued` with exponential backoff
 *   (30 s × 2^(attempt−1), capped at 30 min) until `MAX_JOB_ATTEMPTS` runs, then `error`;
 * - `RequeueJob` (a handler yielding its lane) → back to `queued`, not a failure;
 * - admin cancel → the handler's signal is aborted and the job stays `cancelled`;
 * - shutdown → handlers are aborted and their jobs go back to `queued` (not a failure);
 * - anything else → `error`.
 * Progress is stored at most once per `progressIntervalMs` (and once more at the end).
 * Idle workers sleep until `enqueueJob` notifies them (notify.ts), the next `run_after` is due, or
 * a slow safety poll — never a tight loop. On start, jobs left `running` by a crash are re-queued.
 *
 * Created and started by routes/jobs.ts in onReady, only when `config.startWorkers`.
 */
import type { FastifyBaseLogger } from 'fastify';
import type { EpochMs, Id, JobKind, JobLane, JobProgress } from '@outpost/shared/api';
import type { Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import { RATE_LIMIT_COOLDOWN_MS, UpstreamError, type Upstream } from '../http/upstream.ts';
import { getJobHandler, RequeueJob, type JobContext, type JobHandler } from './handlers.ts';
import { onJobsQueued } from './notify.ts';
import {
  claimNextJob,
  completeJob,
  failJob,
  markCancelled,
  nextRunAfter,
  requeueJob,
  requeueStaleRunning,
  saveProgress,
} from './ops.ts';
import type { JobRow } from './queue.ts';

/** Every lane, one worker each. */
export const JOB_LANES: readonly JobLane[] = ['lichess', 'chesscom', 'local'];
/** First retry delay after a network error / 5xx. */
export const BACKOFF_BASE_MS = 30_000;
/** Longest retry delay. */
export const BACKOFF_MAX_MS = 30 * 60_000;
/** Runs of one job (first run + retries) before it ends in `error`. */
export const MAX_JOB_ATTEMPTS = 8;
/** Minimum time between two progress writes of one job. */
export const PROGRESS_INTERVAL_MS = 1000;
/** Safety poll of an idle worker (notifications normally wake it first). */
export const IDLE_POLL_MS = 60_000;
/** How long shutdown waits for aborted handlers to return. */
export const SHUTDOWN_GRACE_MS = 5000;

/** Delay before retry number `attempt` (1-based: the run that just failed). */
export const backoffDelay = (attempt: number, baseMs: number = BACKOFF_BASE_MS, maxMs: number = BACKOFF_MAX_MS): number =>
  Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));

/** Network errors, timeouts and 5xx answers are worth retrying; 4xx and bugs are not. */
export function isRetryableError(e: unknown): boolean {
  if (!(e instanceof UpstreamError)) return false;
  return e.reason === 'network' || e.reason === 'timeout' || (e.reason === 'status' && (e.status ?? 0) >= 500);
}

/** The reason a worker aborts a handler's signal. */
export class JobAbortedError extends Error {
  override name = 'JobAbortedError';
  readonly why: 'cancel' | 'shutdown';

  constructor(why: 'cancel' | 'shutdown') {
    super(why === 'cancel' ? 'The job was cancelled' : 'The server is shutting down');
    this.why = why;
  }
}

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message || e.name : String(e));

/** Stores `ctx.progress()` snapshots, at most one write per interval, plus a final flush. */
class ProgressWriter {
  #pending: JobProgress | null = null;
  #lastWrite = -Infinity;
  #timer: NodeJS.Timeout | null = null;
  readonly #db: Db;
  readonly #jobId: Id;
  readonly #intervalMs: number;
  readonly #now: () => EpochMs;
  readonly #log: FastifyBaseLogger;

  constructor(db: Db, jobId: Id, intervalMs: number, now: () => EpochMs, log: FastifyBaseLogger) {
    this.#db = db;
    this.#jobId = jobId;
    this.#intervalMs = intervalMs;
    this.#now = now;
    this.#log = log;
  }

  update(p: JobProgress): void {
    this.#pending = p;
    const since = this.#now() - this.#lastWrite;
    if (since >= this.#intervalMs) this.flush();
    else if (!this.#timer) {
      this.#timer = setTimeout(() => this.flush(), this.#intervalMs - since);
      this.#timer.unref();
    }
  }

  flush(): void {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    const p = this.#pending;
    if (!p) return;
    this.#pending = null;
    this.#lastWrite = this.#now();
    try {
      saveProgress(this.#db, this.#jobId, p);
    } catch (e) {
      this.#log.warn({ err: e }, 'could not store job progress');
    }
  }
}

interface LaneState {
  name: JobLane;
  /** A notification arrived while the worker was busy. */
  dirty: boolean;
  /** Resolves the current idle wait. */
  wake: (() => void) | null;
  loop: Promise<void> | null;
}

/** Options of `JobRunner`; everything after `log` is for tests. */
export interface JobRunnerOptions {
  db: Db;
  config: Config;
  upstream: Upstream;
  log: FastifyBaseLogger;
  lanes?: readonly JobLane[];
  now?: () => EpochMs;
  progressIntervalMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  maxAttempts?: number;
  idlePollMs?: number;
  shutdownGraceMs?: number;
}

/** The lane workers of one app. */
export class JobRunner {
  readonly #db: Db;
  readonly #config: Config;
  readonly #upstream: Upstream;
  readonly #log: FastifyBaseLogger;
  readonly #laneNames: readonly JobLane[];
  readonly #now: () => EpochMs;
  readonly #progressIntervalMs: number;
  readonly #backoffBaseMs: number;
  readonly #backoffMaxMs: number;
  readonly #maxAttempts: number;
  readonly #idlePollMs: number;
  readonly #shutdownGraceMs: number;
  readonly #lanes = new Map<JobLane, LaneState>();
  readonly #running = new Map<Id, AbortController>();
  #stopped = true;
  #unsubscribe: (() => void) | null = null;

  constructor(o: JobRunnerOptions) {
    this.#db = o.db;
    this.#config = o.config;
    this.#upstream = o.upstream;
    this.#log = o.log;
    this.#laneNames = o.lanes ?? JOB_LANES;
    this.#now = o.now ?? Date.now;
    this.#progressIntervalMs = o.progressIntervalMs ?? PROGRESS_INTERVAL_MS;
    this.#backoffBaseMs = o.backoffBaseMs ?? BACKOFF_BASE_MS;
    this.#backoffMaxMs = o.backoffMaxMs ?? BACKOFF_MAX_MS;
    this.#maxAttempts = o.maxAttempts ?? MAX_JOB_ATTEMPTS;
    this.#idlePollMs = o.idlePollMs ?? IDLE_POLL_MS;
    this.#shutdownGraceMs = o.shutdownGraceMs ?? SHUTDOWN_GRACE_MS;
  }

  /** Whether the lane loops are running. */
  get started(): boolean {
    return !this.#stopped;
  }

  /** Ids of the jobs whose handlers are running in this process. */
  get runningJobIds(): Id[] {
    return [...this.#running.keys()];
  }

  /** Re-queues jobs a crash left `running`, subscribes to enqueue notifications and starts one loop per lane. */
  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    const stale = requeueStaleRunning(this.#db, this.#maxAttempts, this.#now());
    if (stale > 0) this.#log.info({ jobs: stale }, 're-queued jobs left running by an earlier process');
    this.#unsubscribe = onJobsQueued(this.#db, lane => this.#wake(lane));
    for (const name of this.#laneNames) {
      const lane: LaneState = { name, dirty: false, wake: null, loop: null };
      this.#lanes.set(name, lane);
      lane.loop = this.#loop(lane);
    }
  }

  /**
   * Stops the workers: aborts running handlers, waits up to the grace period for them, and puts
   * their jobs back in the queue so the next start resumes them.
   */
  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    for (const c of this.#running.values()) c.abort(new JobAbortedError('shutdown'));
    for (const lane of this.#lanes.values()) lane.wake?.();
    const loops = [...this.#lanes.values()].map(l => l.loop);
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled(loops),
      new Promise<void>(resolve => {
        timer = setTimeout(resolve, this.#shutdownGraceMs);
      }),
    ]);
    clearTimeout(timer);
    // Handlers that ignored the abort: their jobs still go back to the queue.
    for (const id of this.#running.keys()) {
      try {
        requeueJob(this.#db, id, { runAfter: null, refundAttempt: true });
      } catch (e) {
        this.#log.warn({ err: e, jobId: id }, 'could not re-queue a job at shutdown');
      }
    }
    this.#lanes.clear();
  }

  /** Aborts the handler of a running job (admin cancel). Returns false when it isn't running here. */
  abortJob(id: Id): boolean {
    const c = this.#running.get(id);
    if (!c) return false;
    c.abort(new JobAbortedError('cancel'));
    return true;
  }

  /** Claims and runs the next job of `lane`. Resolves to false when nothing is runnable. */
  async runNext(lane: JobLane): Promise<boolean> {
    const row = claimNextJob(this.#db, lane, this.#now());
    if (!row) return false;
    await this.#execute(row);
    return true;
  }

  #wake(name: JobLane): void {
    const lane = this.#lanes.get(name);
    if (!lane) return;
    if (lane.wake) lane.wake();
    else lane.dirty = true;
  }

  async #loop(lane: LaneState): Promise<void> {
    while (!this.#stopped) {
      let ran = false;
      try {
        ran = await this.runNext(lane.name);
      } catch (e) {
        // A database error while claiming or settling: log it and back off a little.
        this.#log.error({ err: e, lane: lane.name }, 'job worker error');
        await this.#idle(lane, 5000);
        continue;
      }
      if (!ran && !this.#stopped) await this.#idle(lane, this.#sleepFor(lane.name));
    }
  }

  #sleepFor(lane: JobLane): number {
    const now = this.#now();
    const next = nextRunAfter(this.#db, lane, now);
    return next === null ? this.#idlePollMs : Math.max(10, Math.min(this.#idlePollMs, next - now));
  }

  #idle(lane: LaneState, ms: number): Promise<void> {
    if (lane.dirty || this.#stopped) {
      lane.dirty = false;
      return Promise.resolve();
    }
    return new Promise(resolve => {
      const done = (): void => {
        clearTimeout(timer);
        lane.wake = null;
        lane.dirty = false;
        resolve();
      };
      const timer = setTimeout(done, ms);
      timer.unref();
      lane.wake = done;
    });
  }

  async #execute(row: JobRow): Promise<void> {
    const log = this.#log.child({ jobId: row.id, kind: row.kind, lane: row.lane });
    const handler = getJobHandler(row.kind) as JobHandler<JobKind> | undefined;
    if (!handler) {
      failJob(this.#db, row.id, `No handler is registered for "${row.kind}" jobs`, this.#now());
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      failJob(this.#db, row.id, 'The job payload is not valid JSON', this.#now());
      return;
    }

    const controller = new AbortController();
    this.#running.set(row.id, controller);
    const progress = new ProgressWriter(this.#db, row.id, this.#progressIntervalMs, this.#now, log);
    const ctx: JobContext<JobKind> = {
      job: {
        id: row.id,
        kind: row.kind,
        lane: row.lane,
        payload: payload as JobContext<JobKind>['job']['payload'],
        userId: row.user_id,
        attempts: row.attempts,
      },
      db: this.#db,
      config: this.#config,
      upstream: this.#upstream,
      log,
      signal: controller.signal,
      progress: p => progress.update(p),
    };
    const started = this.#now();
    try {
      await handler(ctx);
      progress.flush();
      if (completeJob(this.#db, row.id, this.#now())) log.info({ ms: this.#now() - started }, 'job done');
    } catch (e) {
      progress.flush();
      this.#settleFailure(row, e, controller.signal, log);
    } finally {
      this.#running.delete(row.id);
    }
  }

  #settleFailure(row: JobRow, e: unknown, signal: AbortSignal, log: FastifyBaseLogger): void {
    const now = this.#now();
    const aborted = signal.aborted && signal.reason instanceof JobAbortedError ? signal.reason.why : null;
    if (aborted === 'cancel') {
      markCancelled(this.#db, row.id, now);
      log.info('job cancelled');
      return;
    }
    if (aborted === 'shutdown') {
      requeueJob(this.#db, row.id, { runAfter: null, refundAttempt: true });
      log.info('job interrupted by shutdown, re-queued');
      return;
    }
    if (e instanceof RequeueJob) {
      requeueJob(this.#db, row.id, { runAfter: e.runAfter, refundAttempt: true });
      log.debug({ runAfter: e.runAfter }, e.message);
      return;
    }
    if (e instanceof UpstreamError && e.reason === 'rate_limited') {
      const at = e.retryAt !== null ? Math.max(e.retryAt, now + 1000) : now + RATE_LIMIT_COOLDOWN_MS;
      requeueJob(this.#db, row.id, {
        runAfter: at,
        refundAttempt: true,
        error: `${e.message}; waiting until ${new Date(at).toISOString()}`,
      });
      log.info({ retryAt: at }, 'rate limited, job re-queued');
      return;
    }
    const message = errorMessage(e);
    if (isRetryableError(e) && row.attempts < this.#maxAttempts) {
      const at = now + backoffDelay(row.attempts, this.#backoffBaseMs, this.#backoffMaxMs);
      requeueJob(this.#db, row.id, {
        runAfter: at,
        refundAttempt: false,
        error: `${message} (attempt ${row.attempts} of ${this.#maxAttempts}; retrying at ${new Date(at).toISOString()})`,
      });
      log.warn({ err: e, retryAt: at, attempt: row.attempts }, 'job failed, will retry');
      return;
    }
    failJob(this.#db, row.id, message, now);
    log.warn({ err: e }, 'job failed');
  }
}
