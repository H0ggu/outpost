/**
 * The jobs scheduler (PLAN §7 "Scheduling"): a once-a-minute tick that runs
 * - the **daily auto refresh**: at `autoRefreshHourUtc` (admin setting), enqueue a sync of every
 *   Lichess/Chess.com source of every profile with `auto_refresh` (deduplicated per source), once
 *   per UTC day — the day is stored in `job_scheduler_state`, so restarts neither skip nor repeat it;
 * - **pruning** of finished jobs (hourly);
 * - any extra periodic task the caller adds (routes/jobs.ts adds the opponent geo-lookup sweep).
 *
 * Started by routes/jobs.ts in onReady, only when `config.startWorkers`.
 */
import type { FastifyBaseLogger } from 'fastify';
import type { EpochMs, Id, JobInfo } from '@outpost/shared/api';
import type { Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import { readSettings } from '../settings.ts';
import { pruneFinishedJobs } from './ops.ts';
import { enqueueSync, JOB_PRIORITY } from './queue.ts';

/** How often the scheduler wakes up. */
export const SCHEDULER_TICK_MS = 60_000;
/** Finished jobs are kept this long: done/cancelled 14 days, errors 60 days. */
export const JOB_RETENTION = { doneMs: 14 * 86_400_000, errorMs: 60 * 86_400_000 } as const;

/** Reads a scheduler state value (JSON), or null. */
export function readSchedulerState<T>(db: Db, key: string): T | null {
  const v = db.value<string>('SELECT value FROM job_scheduler_state WHERE key = ?', [key]);
  if (v === undefined) return null;
  try {
    return JSON.parse(v) as T;
  } catch {
    return null;
  }
}

/** Writes a scheduler state value (JSON). */
export function writeSchedulerState(db: Db, key: string, value: unknown): void {
  db.run(
    'INSERT INTO job_scheduler_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    [key, JSON.stringify(value)],
  );
}

/** `YYYY-MM-DD` of an instant, UTC. */
export const utcDay = (t: EpochMs): string => new Date(t).toISOString().slice(0, 10);

const AUTO_REFRESH_KEY = 'autoRefresh.lastDay';

/** Lichess and Chess.com sources of profiles with auto refresh on. */
export function autoRefreshSourceIds(db: Db): Id[] {
  return db
    .all<{ id: Id }>(
      `SELECT DISTINCT s.id FROM sources s
         JOIN profile_sources ps ON ps.source_id = s.id
         JOIN profiles p ON p.id = ps.profile_id
        WHERE p.auto_refresh = 1 AND s.kind IN ('lichess', 'chesscom')
        ORDER BY s.id`,
    )
    .map(r => r.id);
}

/**
 * Runs the daily auto refresh when it is due: the UTC hour has reached `autoRefreshHourUtc` and it
 * hasn't run yet this UTC day. Returns the jobs (new or already active) or null when not due.
 */
export function runAutoRefreshIfDue(db: Db, config: Config, now: EpochMs): JobInfo[] | null {
  const { autoRefreshHourUtc } = readSettings(db, config);
  const day = utcDay(now);
  if (new Date(now).getUTCHours() < autoRefreshHourUtc) return null;
  if (readSchedulerState<string>(db, AUTO_REFRESH_KEY) === day) return null;
  return db.tx(() => {
    const jobs = autoRefreshSourceIds(db).map(id => enqueueSync(db, id, { priority: JOB_PRIORITY.scheduled, userId: null }));
    writeSchedulerState(db, AUTO_REFRESH_KEY, day);
    return jobs;
  });
}

/** A periodic task run by the scheduler tick. Its last run time is persisted. */
export interface ScheduledTask {
  name: string;
  /** Minimum time between runs (0 = every tick). */
  everyMs: number;
  run(now: EpochMs): void;
}

/** Options of `Scheduler` (`now` and `tickMs` are for tests). */
export interface SchedulerOptions {
  db: Db;
  config: Config;
  log: FastifyBaseLogger;
  tasks?: readonly ScheduledTask[];
  now?: () => EpochMs;
  tickMs?: number;
}

/** The scheduler of one app. */
export class Scheduler {
  readonly #db: Db;
  readonly #log: FastifyBaseLogger;
  readonly #now: () => EpochMs;
  readonly #tickMs: number;
  readonly #tasks: ScheduledTask[];
  #timer: NodeJS.Timeout | null = null;
  #first: NodeJS.Timeout | null = null;

  constructor(o: SchedulerOptions) {
    this.#db = o.db;
    this.#log = o.log;
    this.#now = o.now ?? Date.now;
    this.#tickMs = o.tickMs ?? SCHEDULER_TICK_MS;
    this.#tasks = [
      {
        name: 'autoRefresh',
        everyMs: 0,
        run: now => {
          const jobs = runAutoRefreshIfDue(o.db, o.config, now);
          if (jobs) this.#log.info({ sources: jobs.length }, 'daily auto refresh queued');
        },
      },
      {
        name: 'pruneJobs',
        everyMs: 60 * 60_000,
        run: now => {
          const n = pruneFinishedJobs(o.db, now, JOB_RETENTION);
          if (n > 0) this.#log.info({ jobs: n }, 'pruned finished jobs');
        },
      },
      ...(o.tasks ?? []),
    ];
  }

  /** Runs a first tick shortly after start, then one per `tickMs`. */
  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => this.tick(), this.#tickMs);
    this.#timer.unref();
    this.#first = setTimeout(() => this.tick(), Math.min(5000, this.#tickMs));
    this.#first.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    if (this.#first) clearTimeout(this.#first);
    this.#timer = null;
    this.#first = null;
  }

  /** Runs every task that is due. Task errors are logged, never thrown. */
  tick(): void {
    const now = this.#now();
    for (const task of this.#tasks) {
      const key = `task.${task.name}.lastRunAt`;
      try {
        const last = task.everyMs > 0 ? readSchedulerState<number>(this.#db, key) : null;
        if (last !== null && now - last < task.everyMs) continue;
        task.run(now);
        if (task.everyMs > 0) writeSchedulerState(this.#db, key, now);
      } catch (e) {
        this.#log.error({ err: e, task: task.name }, 'scheduled task failed');
      }
    }
  }
}
