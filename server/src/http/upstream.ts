/**
 * The one way to call Lichess, Chess.com and every other upstream service (PLAN §0.3, §7, §10).
 *
 * Every module uses `app.upstream` (job handlers: `ctx.upstream`) and never calls `fetch()`
 * directly. One shared client means:
 * - every request sends `User-Agent: Outpost/<ver> (self-hosted; contact: …)` (Chess.com refuses
 *   anonymous agents);
 * - the Lichess token (env wins over the admin setting) is added only for Lichess hosts, only when
 *   the caller asks (`auth`), and never reaches the browser;
 * - a 429 from a host puts **that host** in a cool-down (Retry-After, at least 60 s) that every
 *   module sees: Lichess limits per token and IP, so one module's burst would otherwise get the
 *   others throttled too. During a cool-down calls fail fast with `UpstreamError('rate_limited')`;
 *   job workers reschedule at `retryAt`, routes answer 503 via `upstreamHttpError`;
 * - requests time out (`timeoutMs`, default 20 s until the response headers arrive);
 * - failures are `UpstreamError`s with a `reason`, the host, the status and `retryAt`.
 *
 * What stays with the calling module: caching (`http_cache`), per-endpoint request budgets
 * (e.g. the explorer's 20 requests/min queue), one-request-in-flight per lane (the job workers),
 * and exponential backoff on 5xx.
 *
 * Tests: `makeTestApp({ fetch })` injects a fake fetch; by default tests have no network.
 */
import type { EpochMs } from '@outpost/shared/api';
import type { Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import { readSettings, userAgent } from '../settings.ts';
import { HttpError } from './errors.ts';

/** Base URLs of the upstream services Outpost uses. Build request URLs from these. */
export const UPSTREAM = {
  lichess: 'https://lichess.org',
  explorer: 'https://explorer.lichess.org',
  tablebase: 'https://tablebase.lichess.ovh',
  database: 'https://database.lichess.org',
  chesscom: 'https://api.chess.com',
  nnue: 'https://tests.stockfishchess.org',
} as const;

/** Hosts that may receive the Lichess token. */
export const LICHESS_TOKEN_HOSTS: ReadonlySet<string> = new Set(['lichess.org', 'explorer.lichess.org']);

/** Minimum cool-down after a 429 (PLAN §7: back off 60 s or more). */
export const RATE_LIMIT_COOLDOWN_MS = 60_000;
/** Default time allowed until the response headers arrive. */
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 20_000;

/** Why an upstream call failed. */
export type UpstreamFailure =
  | 'rate_limited' // 429 now, or the host is still cooling down from an earlier 429
  | 'status' // an HTTP status the caller did not allow (4xx/5xx)
  | 'timeout' // no response headers within timeoutMs
  | 'aborted' // the caller's signal fired
  | 'network' // DNS, TLS, connection reset, ...
  | 'no_token'; // auth: 'required' but no Lichess token is configured

/** A failed upstream call. */
export class UpstreamError extends Error {
  override name = 'UpstreamError';
  readonly reason: UpstreamFailure;
  readonly host: string;
  /** HTTP status when there was a response. */
  readonly status: number | null;
  /** When to try again (rate limits): epoch ms. */
  readonly retryAt: EpochMs | null;

  constructor(
    reason: UpstreamFailure,
    host: string,
    message: string,
    opts: { status?: number | null; retryAt?: EpochMs | null; cause?: unknown } = {},
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.reason = reason;
    this.host = host;
    this.status = opts.status ?? null;
    this.retryAt = opts.retryAt ?? null;
  }
}

/** Options of one upstream request. */
export interface UpstreamInit {
  method?: 'GET' | 'HEAD' | 'POST';
  /** Extra headers. `User-Agent` and `Authorization` are managed by the client. */
  headers?: Record<string, string>;
  body?: string | URLSearchParams;
  /**
   * Send the Lichess token (Lichess hosts only; anything else throws):
   * `false` (default) never, `'optional'` when one is configured, `'required'` → `UpstreamError('no_token')`
   * without one (routes map it to 503 `upstream_unavailable`).
   */
  auth?: false | 'optional' | 'required';
  /** Abort when the response headers take longer than this (default 20 s). Reading the body is not covered: pass `signal`. */
  timeoutMs?: number;
  /** Caller cancellation (request closed, job cancelled). Also aborts body reads. */
  signal?: AbortSignal;
  /** Statuses returned instead of thrown, in addition to 2xx and 304 (e.g. `[404]` when "not found" is an answer). */
  allowStatuses?: readonly number[];
}

/** The shared upstream client (`app.upstream`). */
export interface Upstream {
  /** Raw response (2xx, 304 or an allowed status); stream `res.body` for NDJSON / large files. */
  fetch(url: string | URL, init?: UpstreamInit): Promise<Response>;
  /** `fetch` with `Accept: application/json`, parsed. Use `fetch` when a status other than 2xx is allowed. */
  json<T>(url: string | URL, init?: UpstreamInit): Promise<T>;
  /** End of the current 429 cool-down for a host (`lichess.org`), or null. */
  cooldownUntil(host: string): EpochMs | null;
  /** Starts (or extends) a host's cool-down, e.g. after a 429 seen mid-stream. */
  coolDown(host: string, ms?: number): void;
}

/** Dependencies of `createUpstream`. `fetch` and `now` are injectable for tests. */
export interface UpstreamDeps {
  config: Config;
  db: Db;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

/** Parses Retry-After (seconds or an HTTP date) into ms from now; null when absent or invalid. */
export function parseRetryAfter(value: string | null, now: number): number | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : Math.max(0, t - now);
}

/** Creates the client. `buildApp` makes one per app and decorates it as `app.upstream`. */
export function createUpstream(deps: UpstreamDeps): Upstream {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? Date.now;
  const cooldowns = new Map<string, EpochMs>();

  const cooldownUntil = (host: string): EpochMs | null => {
    const until = cooldowns.get(host);
    if (until === undefined) return null;
    if (until <= now()) {
      cooldowns.delete(host);
      return null;
    }
    return until;
  };

  const coolDown = (host: string, ms: number = RATE_LIMIT_COOLDOWN_MS): void => {
    const until = now() + Math.max(ms, RATE_LIMIT_COOLDOWN_MS);
    if ((cooldowns.get(host) ?? 0) < until) cooldowns.set(host, until);
  };

  const upstreamFetch = async (input: string | URL, init: UpstreamInit = {}): Promise<Response> => {
    const url = new URL(input);
    const host = url.host;
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new UpstreamError('network', host, `Unsupported upstream URL scheme: ${url.protocol}`);
    }

    const until = cooldownUntil(host);
    if (until !== null) {
      throw new UpstreamError('rate_limited', host, `${host} is rate limiting Outpost; retry after ${new Date(until).toISOString()}`, {
        status: 429,
        retryAt: until,
      });
    }

    const settings = readSettings(deps.db, deps.config);
    const headers = new Headers(init.headers);
    headers.set('user-agent', userAgent(deps.config.version, settings.chesscomContact));
    const auth = init.auth ?? false;
    if (auth !== false) {
      if (!LICHESS_TOKEN_HOSTS.has(url.hostname)) {
        throw new Error(`Refusing to send the Lichess token to ${url.hostname}`);
      }
      if (settings.lichessToken) headers.set('authorization', `Bearer ${settings.lichessToken}`);
      else if (auth === 'required') {
        throw new UpstreamError('no_token', host, 'A Lichess API token is required: set LICHESS_TOKEN or add one in the admin settings');
      }
    } else {
      headers.delete('authorization');
    }

    const timeoutMs = init.timeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
    const timeout = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      timeout.abort();
    }, timeoutMs);
    // AbortSignal.any keeps no listener on a long-lived caller signal (e.g. a job's ctx.signal reused
    // for hundreds of requests); the caller's signal keeps covering the body after the headers.
    const signal = init.signal ? AbortSignal.any([timeout.signal, init.signal]) : timeout.signal;

    let res: Response;
    try {
      res = await doFetch(url, {
        method: init.method ?? 'GET',
        headers,
        body: init.body ?? null,
        signal,
        redirect: 'follow',
      });
    } catch (e) {
      if (init.signal?.aborted) throw new UpstreamError('aborted', host, `Request to ${host} was cancelled`, { cause: e });
      if (timedOut) throw new UpstreamError('timeout', host, `${host} did not answer within ${timeoutMs} ms`, { cause: e });
      throw new UpstreamError('network', host, `Could not reach ${host}: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 429) {
      void res.body?.cancel().catch(() => {});
      coolDown(host, parseRetryAfter(res.headers.get('retry-after'), now()) ?? RATE_LIMIT_COOLDOWN_MS);
      const retryAt = cooldownUntil(host);
      throw new UpstreamError('rate_limited', host, `${host} answered 429 Too Many Requests`, { status: 429, retryAt });
    }
    if ((res.status >= 200 && res.status < 300) || res.status === 304 || init.allowStatuses?.includes(res.status)) {
      return res;
    }
    void res.body?.cancel().catch(() => {});
    throw new UpstreamError('status', host, `${host} answered ${res.status} for ${url.pathname}`, { status: res.status });
  };

  return {
    fetch: upstreamFetch,
    async json<T>(url: string | URL, init: UpstreamInit = {}): Promise<T> {
      const res = await upstreamFetch(url, { ...init, headers: { accept: 'application/json', ...init.headers } });
      try {
        return (await res.json()) as T;
      } catch (e) {
        throw new UpstreamError('status', new URL(url).host, `Invalid JSON from ${new URL(url).host}`, { status: res.status, cause: e });
      }
    },
    cooldownUntil,
    coolDown,
  };
}

/**
 * Maps an upstream failure to the API error a route should answer with:
 * rate limits, timeouts, network errors and a missing token → 503 `upstream_unavailable`
 * (`details.retryAt` when known); other statuses → 502 `upstream_error`. Anything that is not an
 * `UpstreamError` is returned unchanged (rethrow it).
 */
export function upstreamHttpError(e: unknown): unknown {
  if (!(e instanceof UpstreamError)) return e;
  if (e.reason === 'status') return new HttpError(502, 'upstream_error', e.message, { host: e.host, status: e.status });
  return new HttpError(503, 'upstream_unavailable', e.message, {
    host: e.host,
    reason: e.reason,
    ...(e.retryAt !== null ? { retryAt: e.retryAt } : {}),
  });
}
