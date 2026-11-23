/**
 * Opponent geo lookups (PLAN §7 "After inserting games" step 3): country and title of every
 * Lichess / Chess.com opponent, for the world map and the opponents tab.
 *
 * `players_cache` is the queue: a row with `fetched_at IS NULL` is waiting for a lookup (the world
 * map counts those as `pendingLookups`). After a sync, `queueOpponentLookups` adds the source's
 * new opponents and enqueues one `geo` job per site (dedupe key `geo:<site>`, background priority).
 * The job works through every pending row of its site:
 * - Lichess: `POST /api/users` with up to 300 ids per request (country from `profile.flag`);
 * - Chess.com: `/pub/player/{u}` one at a time (serial, as the PubAPI asks).
 * It yields its lane (`RequeueJob`) after a chunk so syncs don't wait behind thousands of
 * lookups; a scheduler sweep re-queues lookups that no job is handling. Unknown and closed
 * accounts are stored as looked up with no country. Chess.com titles found here are also
 * written to the games of that site (`backfillPlayerTitle`), which carry none.
 */
import type { EpochMs, JobInfo } from '@outpost/shared/api';
import { playerKey } from '@outpost/shared/chess';
import { backfillPlayerTitle } from '../chess/store.ts';
import type { Db } from '../db/index.ts';
import { UPSTREAM } from '../http/upstream.ts';
import { RequeueJob, type JobContext } from '../jobs/handlers.ts';
import { enqueueJob, geoDedupeKey, JOB_PRIORITY } from '../jobs/queue.ts';
import { CHESSCOM_HOST, CHESSCOM_USERNAME_RE, chesscomDisplayName, type ChesscomProfile } from './chesscom.ts';
import { countryFromChesscom, countryFromLichessFlag, readJsonBody, throwIfAborted, titleOrNull, upsertPlayerCache } from './common.ts';
import { LICHESS_HOST, LICHESS_USERNAME_RE, type LichessUser } from './lichess.ts';

/** Sites with opponent lookups. */
export type GeoSite = 'lichess' | 'chesscom';
export const GEO_SITES: readonly GeoSite[] = ['lichess', 'chesscom'];
/** Ids per `POST /api/users` (Lichess's limit). */
export const LICHESS_USERS_BATCH = 300;
/** Lichess requests per run before the job yields its lane. */
export const LICHESS_BATCHES_PER_RUN = 10;
/** Chess.com profiles per run before the job yields its lane. */
export const CHESSCOM_LOOKUPS_PER_RUN = 50;
/** After a lookup job failed, the sweep leaves the site alone this long. */
export const GEO_RETRY_AFTER_ERROR_MS = 60 * 60_000;

/** Opponents of a site still waiting for a lookup. */
export function pendingLookupCount(db: Db, site: GeoSite): number {
  return db.value<number>('SELECT COUNT(*) FROM players_cache WHERE kind = ? AND fetched_at IS NULL', [site]) ?? 0;
}

/** Enqueues the site's lookup job when rows are pending (deduplicated). Returns it, or null. */
export function enqueuePendingLookups(db: Db, site: GeoSite): JobInfo | null {
  if (pendingLookupCount(db, site) === 0) return null;
  return enqueueJob(db, 'geo', { kind: site, keys: [] }, { priority: JOB_PRIORITY.background, dedupeKey: geoDedupeKey(site), userId: null });
}

/**
 * After a sync: marks the source's opponents that Outpost has never looked up as pending and
 * enqueues the site's lookup job. Returns the job, or null when nothing is pending.
 */
export function queueOpponentLookups(db: Db, sourceId: number, site: GeoSite): JobInfo | null {
  db.run(
    `INSERT OR IGNORE INTO players_cache (kind, key, name, fetched_at)
     SELECT opp_source_kind, opp_key, MAX(opp_name), NULL FROM player_games
      WHERE source_id = ? AND opp_source_kind = ?
      GROUP BY opp_key`,
    [sourceId, site],
  );
  return enqueuePendingLookups(db, site);
}

/**
 * Scheduler task: enqueues lookups that no job is handling (rows added after a job finished, or a
 * job that failed more than an hour ago). Returns the jobs enqueued or found active.
 */
export function sweepPendingLookups(db: Db, now: EpochMs): JobInfo[] {
  const out: JobInfo[] = [];
  for (const site of GEO_SITES) {
    const recentError = db.value<number>(
      "SELECT 1 FROM jobs WHERE kind = 'geo' AND dedupe_key = ? AND status = 'error' AND finished_at > ? LIMIT 1",
      [geoDedupeKey(site), now - GEO_RETRY_AFTER_ERROR_MS],
    );
    if (recentError) continue;
    const job = enqueuePendingLookups(db, site);
    if (job) out.push(job);
  }
  return out;
}

const markUnknown = (db: Db, site: GeoSite, key: string, now: EpochMs): void =>
  upsertPlayerCache(db, site, key, { country: null, title: null, name: null }, now);

/** Progress done in earlier runs of this job (it yields and resumes). */
const previousDone = (ctx: JobContext): number =>
  ctx.db.value<number>("SELECT json_extract(progress_json, '$.done') FROM jobs WHERE id = ?", [ctx.job.id]) ?? 0;

async function lookUpLichess(ctx: JobContext<'geo'>): Promise<void> {
  const { db, upstream, signal } = ctx;
  let done = previousDone(ctx);
  let found = 0;
  for (let request = 0; ; request++) {
    throwIfAborted(signal);
    const keys = db
      .all<{ key: string }>("SELECT key FROM players_cache WHERE kind = 'lichess' AND fetched_at IS NULL ORDER BY key LIMIT ?", [
        LICHESS_USERS_BATCH,
      ])
      .map(r => r.key);
    if (keys.length === 0) break;
    if (request >= LICHESS_BATCHES_PER_RUN) throw new RequeueJob(`Looked up ${done} Lichess players; yielding the lane`);
    const valid = keys.filter(k => LICHESS_USERNAME_RE.test(k));
    let users: LichessUser[] = [];
    if (valid.length > 0) {
      const res = await upstream.fetch(`${UPSTREAM.lichess}/api/users`, {
        method: 'POST',
        body: valid.join(','),
        auth: 'optional',
        signal,
        headers: { accept: 'application/json', 'content-type': 'text/plain' },
      });
      const body = await readJsonBody<unknown>(res, LICHESS_HOST, signal);
      users = Array.isArray(body) ? (body as LichessUser[]) : [];
    }
    const byId = new Map(users.filter(u => u && typeof u.id === 'string').map(u => [u.id.toLowerCase(), u]));
    const now = Date.now();
    db.tx(() => {
      for (const key of keys) {
        const u = byId.get(key);
        if (!u || u.disabled) {
          markUnknown(db, 'lichess', key, now);
          continue;
        }
        found++;
        upsertPlayerCache(
          db,
          'lichess',
          key,
          { country: countryFromLichessFlag(u.profile?.flag ?? u.profile?.country), title: titleOrNull(u.title), name: u.username },
          now,
        );
      }
    });
    done += keys.length;
    ctx.progress({
      done,
      total: done + pendingLookupCount(db, 'lichess'),
      message: `Looked up ${done} Lichess player${done === 1 ? '' : 's'}`,
      counts: { found },
    });
  }
}

async function lookUpChesscom(ctx: JobContext<'geo'>): Promise<void> {
  const { db, upstream, signal } = ctx;
  let done = previousDone(ctx);
  let found = 0;
  for (let n = 0; ; n++) {
    throwIfAborted(signal);
    const row = db.get<{ key: string }>("SELECT key FROM players_cache WHERE kind = 'chesscom' AND fetched_at IS NULL ORDER BY key LIMIT 1");
    if (!row) break;
    if (n >= CHESSCOM_LOOKUPS_PER_RUN) throw new RequeueJob(`Looked up ${done} Chess.com players; yielding the lane`);
    const key = row.key;
    if (!CHESSCOM_USERNAME_RE.test(key)) markUnknown(db, 'chesscom', key, Date.now());
    else {
      const res = await upstream.fetch(`${UPSTREAM.chesscom}/pub/player/${encodeURIComponent(key)}`, {
        signal,
        allowStatuses: [404, 410],
        headers: { accept: 'application/json' },
      });
      if (res.status === 404 || res.status === 410) {
        void res.body?.cancel().catch(() => {});
        markUnknown(db, 'chesscom', key, Date.now());
      } else {
        const p = await readJsonBody<ChesscomProfile>(res, CHESSCOM_HOST, signal);
        if (!p || typeof p.username !== 'string') markUnknown(db, 'chesscom', key, Date.now());
        else {
          found++;
          const title = titleOrNull(p.title);
          db.tx(() => {
            upsertPlayerCache(db, 'chesscom', key, { country: countryFromChesscom(p.country), title, name: chesscomDisplayName(p) }, Date.now());
            if (title) backfillPlayerTitle(db, 'chesscom', key, title);
          });
        }
      }
    }
    done++;
    ctx.progress({
      done,
      total: done + pendingLookupCount(db, 'chesscom'),
      message: `Looked up ${done} Chess.com player${done === 1 ? '' : 's'}`,
      counts: { found },
    });
  }
}

/**
 * The `geo` job handler. `payload.keys` (optional) are looked up again even if known; an empty
 * list means "whatever is pending". Every pending row of the site is processed either way.
 */
export async function geoHandler(ctx: JobContext<'geo'>): Promise<void> {
  const { kind, keys } = ctx.job.payload;
  if (kind !== 'lichess' && kind !== 'chesscom') throw new Error(`Unknown geo lookup site: ${String(kind)}`);
  if (Array.isArray(keys) && keys.length > 0) {
    ctx.db.tx(() => {
      for (const k of keys) {
        if (typeof k !== 'string' || !k.trim()) continue;
        ctx.db.run(
          `INSERT INTO players_cache (kind, key, fetched_at) VALUES (?, ?, NULL)
           ON CONFLICT (kind, key) DO UPDATE SET fetched_at = NULL`,
          [kind, playerKey(k)],
        );
      }
    });
  }
  if (kind === 'lichess') await lookUpLichess(ctx);
  else await lookUpChesscom(ctx);
}
