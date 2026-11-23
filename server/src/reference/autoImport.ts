/**
 * Auto-import of finished official broadcast rounds into the built-in "Lichess broadcasts"
 * reference database (PLAN §5 "Finished rounds can be auto-imported"). Runs on a timer started by
 * routes/reference.ts **only when `config.startWorkers`**, and each tick does nothing unless the
 * admin setting `broadcastAutoImport` is on and a Lichess token is configured.
 *
 * A tick:
 * 1. reads Lichess's top list (`/api/broadcast/top`): every active tour, plus finished tours page
 *    by page while the page still has tours that ended within the window (at most
 *    `AUTO_IMPORT_MAX_PAST_PAGES`), so every tier is covered and a tour's last round is seen
 *    after the tour has left the active list;
 * 2. fetches the rounds of each of those tours whose state in the list changed since it was last
 *    checked (its current and latest rounds, `reference_broadcast_tours.signature`) or that was
 *    checked a day ago — at most `AUTO_IMPORT_MAX_TOUR_FETCHES` per tick, the rest next tick;
 * 3. queues a low-priority 'broadcastRound' job for every round that finished within the window
 *    and is not imported yet (a 'partial' import is redone; a failed one is retried after a day).
 *
 * Requests are serial, carry the token and have a deadline; the first failure ends the tick (a 429
 * already cools lichess.org down for every module), and the next tick carries on. Older events
 * come from the monthly dumps.
 */
import type { FastifyBaseLogger } from 'fastify';
import type { Id, JobInfo } from '@outpost/shared/api';
import { fetchTopBroadcasts, fetchTour, type LichessRound, type LichessTopEntry } from '../broadcasts/lichess.ts';
import type { Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import { HttpError } from '../http/errors.ts';
import type { Upstream } from '../http/upstream.ts';
import { enqueueJob, JOB_PRIORITY } from '../jobs/index.ts';
import { readSettings } from '../settings.ts';
import { ensureBroadcastDatabase } from './databases.ts';

/** Time between ticks, and the delay of the first one after start-up. */
export const AUTO_IMPORT_INTERVAL_MS = 15 * 60 * 1000;
export const AUTO_IMPORT_FIRST_DELAY_MS = 60 * 1000;
/** Rounds that finished longer ago than this are left to the monthly dumps. */
export const AUTO_IMPORT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** A failed round is tried again after this long; an unchanged tour is checked again as often. */
export const AUTO_IMPORT_RETRY_MS = 24 * 60 * 60 * 1000;
/** Most rounds queued per tick. */
export const AUTO_IMPORT_MAX_PER_TICK = 40;
/** Most tour round lists fetched per tick. */
export const AUTO_IMPORT_MAX_TOUR_FETCHES = 25;
/** Most pages of finished tours read per tick (24 tours a page). */
export const AUTO_IMPORT_MAX_PAST_PAGES = 6;
/** Deadline of one upstream request (body included). */
const REQUEST_DEADLINE_MS = 30_000;
/** Tour states not seen for this long are forgotten. */
const FORGET_TOURS_MS = 30 * 24 * 60 * 60 * 1000;

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

const roundState = (r: LichessRound | null): string => (r ? `${r.id}:${r.finished ? 'f' : r.ongoing ? 'o' : 'u'}` : '-');

/** What the top list says about a tour; when it changes, rounds may have finished. */
export const tourSignature = (e: LichessTopEntry): string => `${roundState(e.round)}|${roundState(e.roundToLink)}`;

/** When a round ended (its finish, else its start), or null when unknown. */
const endedAt = (r: LichessRound | null | undefined): number | null => r?.finishedAt ?? r?.startsAt ?? null;

/**
 * Queues one finished round unless it is imported, failed less than a day ago, or already queued.
 * Returns the new job, or null.
 */
function queueRound(db: Db, databaseId: Id, roundId: string, now: number): JobInfo | null {
  const known = db.get<{ status: string; updated_at: number }>(
    'SELECT status, updated_at FROM reference_broadcast_rounds WHERE database_id = ? AND round_id = ?',
    [databaseId, roundId],
  );
  if (known?.status === 'imported') return null;
  if (known?.status === 'error' && now - known.updated_at < AUTO_IMPORT_RETRY_MS) return null;
  const dedupeKey = broadcastRoundDedupeKey(databaseId, roundId);
  if (db.get("SELECT 1 FROM jobs WHERE dedupe_key = ? AND status IN ('queued', 'running')", [dedupeKey])) return null;
  return enqueueJob(db, 'broadcastRound', { databaseId, roundId }, { priority: JOB_PRIORITY.background, dedupeKey });
}

/** One auto-import tick. Returns the jobs it queued (empty when disabled or nothing is new). */
export async function autoImportFinishedRounds(deps: AutoImportDeps): Promise<JobInfo[]> {
  const { db } = deps;
  const settings = readSettings(db, deps.config);
  if (!settings.broadcastAutoImport || !settings.lichessToken) return [];
  const now = deps.now ?? Date.now();
  const since = now - AUTO_IMPORT_WINDOW_MS;
  const deadline = (): AbortSignal =>
    deps.signal ? AbortSignal.any([deps.signal, AbortSignal.timeout(REQUEST_DEADLINE_MS)]) : AbortSignal.timeout(REQUEST_DEADLINE_MS);

  // 1. Candidate tours: active ones, and finished ones whose last round ended within the window.
  const candidates = new Map<string, string>();
  for (let page = 1; page <= AUTO_IMPORT_MAX_PAST_PAGES; ) {
    const top = await fetchTopBroadcasts(deps.upstream, { page, signal: deadline() });
    if (page === 1) for (const e of top.active) if (!candidates.has(e.tour.id)) candidates.set(e.tour.id, tourSignature(e));
    let recent = 0;
    for (const e of top.past) {
      const at = endedAt(e.round);
      if (at === null || at < since) continue;
      recent++;
      if (!candidates.has(e.tour.id)) candidates.set(e.tour.id, tourSignature(e));
    }
    if (recent === 0 || top.nextPastPage === null || top.nextPastPage <= page) break;
    page = top.nextPastPage;
  }

  // 2. Tours to look into: changed (or new) ones first, then those checked a day ago.
  const databaseId = ensureBroadcastDatabase(db);
  const known = new Map(
    db
      .all<{ tour_id: string; signature: string; checked_at: number }>(
        'SELECT tour_id, signature, checked_at FROM reference_broadcast_tours WHERE database_id = ?',
        [databaseId],
      )
      .map(r => [r.tour_id, r]),
  );
  const changed: Array<[string, string]> = [];
  const stale: Array<[string, string]> = [];
  for (const [tourId, signature] of candidates) {
    const k = known.get(tourId);
    if (!k || k.signature !== signature) changed.push([tourId, signature]);
    else if (now - k.checked_at >= AUTO_IMPORT_RETRY_MS) stale.push([tourId, signature]);
  }
  const remember = (tourId: string, signature: string): void => {
    db.run(
      `INSERT INTO reference_broadcast_tours (database_id, tour_id, signature, checked_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (database_id, tour_id) DO UPDATE SET signature = excluded.signature, checked_at = excluded.checked_at`,
      [databaseId, tourId, signature, now],
    );
  };

  // 3. Queue their finished rounds.
  const queued: JobInfo[] = [];
  let fetches = 0;
  for (const [tourId, signature] of [...changed, ...stale]) {
    if (fetches >= AUTO_IMPORT_MAX_TOUR_FETCHES || queued.length >= AUTO_IMPORT_MAX_PER_TICK) break;
    fetches++;
    let rounds: LichessRound[];
    try {
      rounds = (await fetchTour(deps.upstream, tourId, deadline())).rounds;
    } catch (e) {
      if (e instanceof HttpError && e.statusCode === 404) {
        remember(tourId, signature); // deleted or made private upstream
        continue;
      }
      throw e;
    }
    let complete = true;
    for (const r of rounds) {
      const at = endedAt(r);
      if (!r.finished || at === null || at < since) continue;
      if (queued.length >= AUTO_IMPORT_MAX_PER_TICK) {
        complete = false; // the rest of this tour next tick
        break;
      }
      const job = queueRound(db, databaseId, r.id, now);
      if (job) queued.push(job);
    }
    if (complete) remember(tourId, signature);
  }
  db.run('DELETE FROM reference_broadcast_tours WHERE database_id = ? AND checked_at < ?', [databaseId, now - FORGET_TOURS_MS]);
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
