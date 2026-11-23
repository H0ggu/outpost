/**
 * `GET /api/admin/status` (PLAN §6): versions, database size, counts, the Lichess token check and
 * upstream reachability.
 *
 * - Token check: `GET https://lichess.org/api/account` through `app.upstream` with `auth: 'required'`
 *   (no token → `missing`, nothing is sent). 200 → `valid` with the account id and the scopes from
 *   Lichess's `X-OAuth-Scopes` header; 401/403 → `invalid`; anything else → `unknown` with the reason.
 * - Probes: one small request per upstream host, each with a short timeout; hosts are probed in
 *   parallel, requests to one host one at a time (Lichess asks for that). `ok` means the host
 *   answered with an HTTP status below 500: a 4xx (e.g. a refused token or a missing Chess.com
 *   contact) still proves it is reachable, and is reported in `error`. A host in a 429 cool-down is
 *   reported without being contacted.
 * - The token check and the probes are cached for `STATUS_CACHE_MS` and shared by concurrent
 *   requests; changing the token in the admin settings (or `?refresh=1`, at most once per
 *   `STATUS_REFRESH_MIN_MS`) runs them again.
 * - The expensive row counts (games, positions) run in a worker thread (src/auth/rowCounts.ts), so
 *   they never block the server. They are cached like the probes; once known, an expired count is
 *   served while the next one runs in the background (`?refresh=1` waits for it). Cheap counts and
 *   job counts are always fresh.
 */
import { statSync } from 'node:fs';
import type { FastifyBaseLogger } from 'fastify';
import type { AdminStatus, EpochMs, JobStatus, UpstreamStatus } from '@outpost/shared/api';
import type { Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import { UPSTREAM, UpstreamError, type Upstream } from '../http/upstream.ts';
import { readSettings } from '../settings.ts';
import { canCountInWorker, countHeavyRows, countHeavyRowsInWorker, type HeavyCounts } from './rowCounts.ts';

/** How long probe results and row counts are reused. */
export const STATUS_CACHE_MS = 60_000;
/** `?refresh=1` is ignored within this long of the last run (each run costs 5 upstream requests). */
export const STATUS_REFRESH_MIN_MS = 10_000;
/** Timeout of one reachability probe (until the response headers). */
export const PROBE_TIMEOUT_MS = 5_000;
/** Timeout of the token check. */
export const TOKEN_CHECK_TIMEOUT_MS = 8_000;

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** One reachability probe. */
export interface ProbeDef {
  name: UpstreamStatus['name'];
  url: string;
  method: 'GET' | 'HEAD';
  /** Send the Lichess token when one is configured (explorer.lichess.org may refuse anonymous calls). */
  auth?: 'optional';
}

/** The hosts Outpost depends on, each probed with a cheap request. */
export const UPSTREAM_PROBES: readonly ProbeDef[] = [
  { name: 'lichess', url: `${UPSTREAM.lichess}/robots.txt`, method: 'GET' },
  {
    name: 'lichess-explorer',
    url: `${UPSTREAM.explorer}/masters?${new URLSearchParams({ fen: START_FEN, moves: '1', topGames: '0' }).toString()}`,
    method: 'GET',
    auth: 'optional',
  },
  { name: 'chesscom', url: `${UPSTREAM.chesscom}/pub/country/US`, method: 'GET' },
  { name: 'lichess-database', url: `${UPSTREAM.database}/`, method: 'HEAD' },
];

/** Every 4xx/5xx except 429 (which the upstream client turns into a cool-down): returned, not thrown. */
const ERROR_STATUSES: readonly number[] = Array.from({ length: 200 }, (_, i) => 400 + i).filter(s => s !== 429);

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** What an HTTP status says about a probed host (null for 2xx/3xx). */
export function httpProblem(status: number): string | null {
  if (status < 400) return null;
  if (status >= 500) return `HTTP ${status}: the server has a problem`;
  if (status === 401 || status === 403) return `HTTP ${status}: reachable, but it refused the request (check the Lichess token / Chess.com contact)`;
  return `HTTP ${status}: reachable, but it refused the request`;
}

/** Runs one probe; never throws. */
export async function probeUpstream(upstream: Upstream, def: ProbeDef): Promise<UpstreamStatus> {
  const started = performance.now();
  try {
    const res = await upstream.fetch(def.url, {
      method: def.method,
      timeoutMs: PROBE_TIMEOUT_MS,
      allowStatuses: ERROR_STATUSES,
      ...(def.auth ? { auth: def.auth } : {}),
    });
    const latencyMs = Math.round(performance.now() - started);
    void res.body?.cancel().catch(() => {});
    return { name: def.name, url: def.url, ok: res.status < 500, status: res.status, latencyMs, error: httpProblem(res.status) };
  } catch (e) {
    return {
      name: def.name,
      url: def.url,
      ok: false,
      status: e instanceof UpstreamError ? e.status : null,
      latencyMs: null,
      error: errorMessage(e),
    };
  }
}

/** Checks the effective Lichess token; never throws. */
export async function checkLichessToken(upstream: Upstream, db: Db, config: Config): Promise<AdminStatus['lichessToken']> {
  const fromEnv = config.lichessToken !== null;
  const base = { userId: null, scopes: [] as string[], fromEnv };
  if (!readSettings(db, config).lichessToken) {
    return { ...base, configured: false, valid: null, state: 'missing', error: null };
  }
  try {
    const res = await upstream.fetch(`${UPSTREAM.lichess}/api/account`, {
      auth: 'required',
      headers: { accept: 'application/json' },
      timeoutMs: TOKEN_CHECK_TIMEOUT_MS,
      // Also bounds reading the body.
      signal: AbortSignal.timeout(TOKEN_CHECK_TIMEOUT_MS * 2),
      allowStatuses: [401, 403],
    });
    if (res.status === 401 || res.status === 403) {
      void res.body?.cancel().catch(() => {});
      return { ...base, configured: true, valid: false, state: 'invalid', error: `Lichess refused the token (HTTP ${res.status})` };
    }
    const body = (await res.json()) as { id?: unknown };
    const scopes = (res.headers.get('x-oauth-scopes') ?? '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    return {
      ...base,
      configured: true,
      valid: true,
      userId: typeof body.id === 'string' ? body.id : null,
      scopes,
      state: 'valid',
      error: null,
    };
  } catch (e) {
    if (e instanceof UpstreamError && e.reason === 'no_token') {
      return { ...base, configured: false, valid: null, state: 'missing', error: null };
    }
    return { ...base, configured: true, valid: null, state: 'unknown', error: errorMessage(e) };
  }
}

/** Database file plus WAL, in bytes (0 for a missing file). */
export function dbSizeBytes(dbPath: string): number {
  let total = 0;
  for (const p of [dbPath, `${dbPath}-wal`]) {
    try {
      total += statSync(p).size;
    } catch {
      // missing (no WAL yet, or :memory:)
    }
  }
  return total;
}

const JOB_STATUSES: readonly JobStatus[] = ['queued', 'running', 'done', 'error', 'cancelled'];

/** Jobs per status (all statuses present). */
export function jobCounts(db: Db): Record<JobStatus, number> {
  const out = Object.fromEntries(JOB_STATUSES.map(s => [s, 0])) as Record<JobStatus, number>;
  for (const r of db.all<{ status: JobStatus; n: number }>('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status')) {
    if (r.status in out) out[r.status] = r.n;
  }
  return out;
}

interface Probed {
  checkedAt: EpochMs;
  lichessToken: AdminStatus['lichessToken'];
  upstream: UpstreamStatus[];
}

/** The status service of one app (`createStatusService` in the admin plugin). */
export interface StatusService {
  get(opts?: { refresh?: boolean }): Promise<AdminStatus>;
  /** Forget cached probes (e.g. after the Lichess token changed). */
  invalidate(): void;
  /** Stops a running row count (app shutdown). */
  close(): Promise<void>;
}

/** Creates the status service with its probe and row-count caches. `countInWorker: false` is for tests. */
export function createStatusService(deps: {
  db: Db;
  config: Config;
  upstream: Upstream;
  log?: FastifyBaseLogger;
  now?: () => number;
  countInWorker?: boolean;
}): StatusService {
  const { db, config, upstream, log } = deps;
  const now = deps.now ?? Date.now;
  const useWorker = (deps.countInWorker ?? true) && canCountInWorker(db.path);
  const closing = new AbortController();
  let cache: { at: number; value: Promise<Probed>; settled: boolean } | null = null;
  let counts: { at: number; value: HeavyCounts } | null = null;
  let counting: Promise<void> | null = null;

  /** The token check and every probe: hosts in parallel, one request at a time per host. */
  const runChecks = async (): Promise<Pick<Probed, 'lichessToken' | 'upstream'>> => {
    let lichessToken: AdminStatus['lichessToken'] | null = null;
    const results = new Map<ProbeDef, UpstreamStatus>();
    const queues = new Map<string, Array<() => Promise<void>>>();
    const enqueue = (url: string, task: () => Promise<void>): void => {
      const host = new URL(url).host;
      queues.set(host, [...(queues.get(host) ?? []), task]);
    };
    enqueue(UPSTREAM.lichess, async () => {
      lichessToken = await checkLichessToken(upstream, db, config);
    });
    for (const def of UPSTREAM_PROBES) {
      enqueue(def.url, async () => {
        results.set(def, await probeUpstream(upstream, def));
      });
    }
    await Promise.all(
      [...queues.values()].map(async tasks => {
        for (const task of tasks) await task();
      }),
    );
    return { lichessToken: lichessToken!, upstream: UPSTREAM_PROBES.map(d => results.get(d)!) };
  };

  const probe = async (): Promise<Probed> => {
    const checks = await runChecks();
    return { checkedAt: now(), ...checks };
  };

  const probed = (refresh: boolean): Promise<Probed> => {
    const t = now();
    // A refresh joins a run that is still in flight instead of starting another one, and is
    // ignored right after a run.
    const stale = !cache || t - cache.at >= STATUS_CACHE_MS || (refresh && cache.settled && t - cache.at >= STATUS_REFRESH_MIN_MS);
    if (stale) {
      const entry = { at: t, value: probe(), settled: false };
      cache = entry;
      entry.value.then(
        () => {
          entry.settled = true;
        },
        () => {
          if (cache === entry) cache = null;
        },
      );
      return entry.value;
    }
    return cache!.value;
  };

  /** One row count (in the worker when possible), stored in `counts`. Shared while it runs. */
  const recount = (): Promise<void> => {
    counting ??= (async () => {
      const started = now();
      let value: HeavyCounts;
      if (useWorker) {
        try {
          value = await countHeavyRowsInWorker(db.path, { signal: closing.signal });
        } catch (err) {
          if (closing.signal.aborted) throw err;
          // Should not happen (same file, read-only); keep the last numbers rather than block the server.
          log?.warn({ err }, 'could not count rows in a worker thread');
          value = counts?.value ?? countHeavyRows(db);
        }
      } else {
        value = countHeavyRows(db);
      }
      counts = { at: started, value };
    })().finally(() => {
      counting = null;
    });
    return counting;
  };

  const heavyCounts = async (refresh: boolean): Promise<HeavyCounts> => {
    const t = now();
    const stale = !counts || t - counts.at >= STATUS_CACHE_MS || (refresh && t - counts.at >= STATUS_REFRESH_MIN_MS);
    if (stale) {
      const run = recount();
      if (!counts || refresh) await run;
      else run.catch(() => {});
    }
    return counts!.value;
  };

  return {
    async get(opts = {}) {
      const refresh = opts.refresh ?? false;
      const [p, heavy] = await Promise.all([probed(refresh), heavyCounts(refresh)]);
      const jobs = jobCounts(db);
      const count = (sql: string): number => db.value<number>(sql) ?? 0;
      return {
        version: config.version,
        nodeVersion: process.version,
        sqliteVersion: db.value<string>('SELECT sqlite_version()') ?? 'unknown',
        uptimeSec: Math.round(process.uptime()),
        dataDir: config.dataDir,
        dbSizeBytes: dbSizeBytes(config.dbPath),
        lichessToken: p.lichessToken,
        upstream: p.upstream,
        checkedAt: p.checkedAt,
        jobs,
        counts: {
          // Users being deleted (src/auth/purge.ts) are already gone for the admin.
          users: count('SELECT COUNT(*) FROM users WHERE deleting_at IS NULL'),
          profiles: count('SELECT COUNT(*) FROM profiles'),
          sources: count('SELECT COUNT(*) FROM sources'),
          games: heavy.games,
          referenceGames: heavy.referenceGames,
          positions: heavy.positions,
          queuedJobs: jobs.queued,
        },
      };
    },
    invalidate() {
      cache = null;
    },
    async close() {
      closing.abort(new Error('status service closed'));
      await counting?.catch(() => {});
    },
  };
}
