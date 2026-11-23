/**
 * Auto-import of finished official broadcast rounds into the built-in "Lichess broadcasts"
 * reference database (PLAN §5 "Finished rounds can be auto-imported"). Runs on a timer started by
 * routes/reference.ts **only when `config.startWorkers`**, and each tick does nothing unless the
 * admin setting `broadcastAutoImport` is on and a Lichess token is configured.
 *
 * A tick reads the official list (one request), and queues a low-priority 'broadcastRound' job for
 * every round that finished within the last week and is not imported yet (failed rounds are retried
 * once a day). Older events come from the monthly dumps.
 */
import type { FastifyBaseLogger } from 'fastify';
import type { JobInfo } from '@outpost/shared/api';
import { fetchOfficialBroadcasts } from '../broadcasts/lichess.ts';
import type { Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import type { Upstream } from '../http/upstream.ts';
import { enqueueJob, JOB_PRIORITY } from '../jobs/index.ts';
import { readSettings } from '../settings.ts';
import { ensureBroadcastDatabase } from './databases.ts';

/** Time between ticks, and the delay of the first one after start-up. */
export const AUTO_IMPORT_INTERVAL_MS = 15 * 60 * 1000;
export const AUTO_IMPORT_FIRST_DELAY_MS = 60 * 1000;
/** Rounds that finished longer ago than this are left to the monthly dumps. */
export const AUTO_IMPORT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** A failed round is tried again after this long. */
export const AUTO_IMPORT_RETRY_MS = 24 * 60 * 60 * 1000;
/** Most rounds queued per tick. */
export const AUTO_IMPORT_MAX_PER_TICK = 40;
/** Tours read per tick (active first, then the most recently finished). */
const AUTO_IMPORT_TOURS = 60;

/** Dedupe key of a round import job. */
export const broadcastRoundDedupeKey = (databaseId: number, roundId: string): string => `broadcastRound:${databaseId}:${roundId}`;

/** Dependencies of one tick. */
export interface AutoImportDeps {
  db: Db;
  config: Config;
  upstream: Upstream;
  log?: FastifyBaseLogger;
  signal?: AbortSignal;
  now?: number;
}

/** One auto-import tick. Returns the jobs it queued (empty when disabled or nothing is new). */
export async function autoImportFinishedRounds(deps: AutoImportDeps): Promise<JobInfo[]> {
  const settings = readSettings(deps.db, deps.config);
  if (!settings.broadcastAutoImport || !settings.lichessToken) return [];
  const now = deps.now ?? Date.now();
  const tours = await fetchOfficialBroadcasts(deps.upstream, { nb: AUTO_IMPORT_TOURS, ...(deps.signal ? { signal: deps.signal } : {}) });
  const databaseId = ensureBroadcastDatabase(deps.db);
  const queued: JobInfo[] = [];
  for (const t of tours) {
    for (const r of t.rounds) {
      if (queued.length >= AUTO_IMPORT_MAX_PER_TICK) return queued;
      if (!r.finished) continue;
      const finishedAt = r.finishedAt ?? r.startsAt ?? null;
      if (finishedAt === null || finishedAt < now - AUTO_IMPORT_WINDOW_MS) continue;
      const known = deps.db.get<{ status: string; updated_at: number }>(
        'SELECT status, updated_at FROM reference_broadcast_rounds WHERE database_id = ? AND round_id = ?',
        [databaseId, r.id],
      );
      if (known?.status === 'imported') continue;
      if (known?.status === 'error' && now - known.updated_at < AUTO_IMPORT_RETRY_MS) continue;
      const dedupeKey = broadcastRoundDedupeKey(databaseId, r.id);
      if (deps.db.get("SELECT 1 FROM jobs WHERE dedupe_key = ? AND status IN ('queued', 'running')", [dedupeKey])) continue;
      queued.push(enqueueJob(deps.db, 'broadcastRound', { databaseId, roundId: r.id }, { priority: JOB_PRIORITY.background, dedupeKey }));
    }
  }
  if (queued.length) deps.log?.info({ rounds: queued.length }, 'queued finished broadcast rounds for the reference database');
  return queued;
}

/**
 * Starts the timer (call only when `config.startWorkers`). Returns a stop function that cancels the
 * timer and any tick in flight, and resolves once that tick has settled.
 */
export function startBroadcastAutoImport(deps: Omit<AutoImportDeps, 'now' | 'signal'>): () => Promise<void> {
  const controller = new AbortController();
  let running: Promise<void> | null = null;
  const tick = (): void => {
    if (running || controller.signal.aborted) return;
    running = autoImportFinishedRounds({ ...deps, signal: controller.signal })
      .then(
        () => {},
        e => {
          if (!controller.signal.aborted) deps.log?.warn({ err: e }, 'broadcast auto-import failed');
        },
      )
      .finally(() => {
        running = null;
      });
  };
  const first = setTimeout(tick, AUTO_IMPORT_FIRST_DELAY_MS);
  const every = setInterval(tick, AUTO_IMPORT_INTERVAL_MS);
  first.unref();
  every.unref();
  return async () => {
    clearTimeout(first);
    clearInterval(every);
    controller.abort();
    await running;
  };
}
