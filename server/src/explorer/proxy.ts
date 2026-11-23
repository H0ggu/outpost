/**
 * Proxies to Lichess's explorer, tablebase and cloud-eval services (PLAN §6), all through
 * `app.upstream`:
 *
 * | Upstream                                   | Auth                         | Budget        | Cache        |
 * |--------------------------------------------|------------------------------|---------------|--------------|
 * | explorer.lichess.org/masters, /masters/pgn | none (token only after a 401)| 20/min, FIFO  | 3 h / 30 d   |
 * | explorer.lichess.org/lichess               | token required (503 without) | 20/min, FIFO  | 3 h          |
 * | tablebase.lichess.ovh/<variant>            | none                         | 120/min       | 30 d         |
 * | lichess.org/api/cloud-eval                 | none                         | 60/min        | 30 min (404: 10 min) |
 *
 * Every request first checks `http_cache` (fresh → answered without upstream), then joins an
 * in-flight request for the same key (one upstream call however many clients ask), then waits for
 * a budget slot (FIFO; it leaves the queue when its clients disconnect), and calls upstream with a
 * timeout. When the upstream fails or the budget is exhausted, a stale cached answer is served if
 * there is one (`x-outpost-cache: stale`).
 */
import type { Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import { HttpError } from '../http/errors.ts';
import { UPSTREAM, UpstreamError, upstreamHttpError, type Upstream } from '../http/upstream.ts';
import { readSettings } from '../settings.ts';
import { BudgetError, RequestBudget, type BudgetOptions } from './budget.ts';
import { cacheKey, ExplorerCache, freshness, type CacheEntry, type CacheKind } from './cache.ts';

/** Where an answer came from (sent as `x-outpost-cache`). */
export type CacheOutcome = 'hit' | 'miss' | 'stale' | 'revalidated';

/** A proxied answer: 200, or 404 where "not found" is an answer (cloud-eval, masters PGN). */
export interface ProxyResult {
  status: number;
  body: string;
  contentType: string;
  cache: CacheOutcome;
}

/** Budgets by upstream. */
export type BudgetName = 'masters' | 'lichess' | 'tablebase' | 'cloudEval';

/** Default budgets: the Lichess explorer allows 20 requests per minute (research lichess-api.md §3). */
export const DEFAULT_BUDGETS: Readonly<Record<BudgetName, BudgetOptions>> = {
  masters: { perWindow: 20, windowMs: 60_000, maxQueue: 50, maxWaitMs: 30_000 },
  lichess: { perWindow: 20, windowMs: 60_000, maxQueue: 50, maxWaitMs: 30_000 },
  tablebase: { perWindow: 120, windowMs: 60_000, maxQueue: 100, maxWaitMs: 10_000 },
  cloudEval: { perWindow: 60, windowMs: 60_000, maxQueue: 30, maxWaitMs: 5_000 },
};

/** Time allowed until the upstream's response headers arrive. */
export const UPSTREAM_HEADERS_TIMEOUT_MS = 15_000;
/** Time allowed for the whole upstream response. */
export const UPSTREAM_BODY_TIMEOUT_MS = 30_000;
/** Largest upstream body accepted (explorer answers are a few KB). */
export const MAX_UPSTREAM_BODY_BYTES = 4 * 1024 * 1024;

const JSON_TYPE = 'application/json; charset=utf-8';
const PGN_TYPE = 'application/x-chess-pgn; charset=utf-8';

/** Content type we answer with, per kind (never the upstream's, so nosniff stays meaningful). */
const CONTENT_TYPES: Record<CacheKind, string> = {
  masters: JSON_TYPE,
  lichess: JSON_TYPE,
  'masters-pgn': PGN_TYPE,
  tablebase: JSON_TYPE,
  'cloud-eval': JSON_TYPE,
};

/** Dependencies of `createExplorerProxy`. */
export interface ExplorerProxyDeps {
  db: Db;
  config: Config;
  upstream: Upstream;
  now?: () => number;
  budgets?: Partial<Record<BudgetName, BudgetOptions>>;
  /** Upstream timeouts (defaults: `UPSTREAM_HEADERS_TIMEOUT_MS`, `UPSTREAM_BODY_TIMEOUT_MS`). */
  timeouts?: { headersMs?: number; bodyMs?: number };
  log?: { warn(obj: object, msg: string): void };
}

/** One cacheable upstream request. */
interface UpstreamRequest {
  kind: CacheKind;
  /** Normalised request text (the cache key without its prefix). */
  key: string;
  url: string;
  budget: RequestBudget;
  auth: false | 'optional' | 'required';
  /** Statuses that are answers (cached, returned as `ProxyResult.status`). */
  answers: readonly number[];
  /** Runs before the upstream call (e.g. the token check); may throw. */
  precheck?: () => void;
}

/** Raised for a 401 from an endpoint that is normally anonymous (masters): retry with the token. */
class NeedsToken extends Error {
  override name = 'NeedsToken';
}

interface Flight {
  promise: Promise<ProxyResult>;
  controller: AbortController;
  waiters: number;
}

/** The Lichess proxies of one app. */
export interface ExplorerProxy {
  /** `params`: validated, normalised explorer.lichess.org/masters query. */
  masters(params: URLSearchParams, signal?: AbortSignal): Promise<ProxyResult>;
  /** A Lichess masters game id (8 alphanumerics). */
  mastersPgn(id: string, signal?: AbortSignal): Promise<ProxyResult>;
  /** `params`: validated, normalised explorer.lichess.org/lichess query. */
  lichess(params: URLSearchParams, signal?: AbortSignal): Promise<ProxyResult>;
  tablebase(variant: string, fen: string, signal?: AbortSignal): Promise<ProxyResult>;
  cloudEval(q: { fen: string; multiPv: number; variant: string | null }, signal?: AbortSignal): Promise<ProxyResult>;
  /** Budget state (admin/debug and tests). */
  budget(name: BudgetName): RequestBudget;
  cache: ExplorerCache;
}

/** Reads a response body as text, refusing more than `max` bytes. */
async function readLimitedText(res: Response, max: number, host: string): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? 'NaN');
  if (Number.isFinite(declared) && declared > max) {
    void res.body?.cancel().catch(() => {});
    throw new UpstreamError('status', host, `${host} sent ${declared} bytes (limit ${max})`, { status: res.status });
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new UpstreamError('status', host, `${host} sent more than ${max} bytes`, { status: res.status });
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** A short, single-line excerpt of an upstream error body. */
const excerpt = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, 200);

const isAbort = (e: unknown): boolean =>
  (e instanceof BudgetError && e.reason === 'aborted') ||
  (e instanceof UpstreamError && e.reason === 'aborted') ||
  (e instanceof Error && e.name === 'AbortError');

/** Maps a failure to the HttpError a route answers with. */
export function proxyHttpError(e: unknown): unknown {
  if (e instanceof HttpError) return e;
  if (e instanceof BudgetError) {
    return new HttpError(503, 'upstream_unavailable', `${e.message}; try again shortly`, { reason: e.reason, retryAt: e.retryAt });
  }
  if (e instanceof NeedsToken) {
    return new HttpError(503, 'upstream_unavailable', 'This Lichess explorer needs a Lichess API token: set LICHESS_TOKEN or add one in the admin settings', {
      reason: 'no_token',
    });
  }
  return upstreamHttpError(e);
}

export function createExplorerProxy(deps: ExplorerProxyDeps): ExplorerProxy {
  const now = deps.now ?? Date.now;
  const cache = new ExplorerCache(deps.db, now);
  const budgets = {} as Record<BudgetName, RequestBudget>;
  for (const name of Object.keys(DEFAULT_BUDGETS) as BudgetName[]) {
    budgets[name] = new RequestBudget({ ...DEFAULT_BUDGETS[name], ...deps.budgets?.[name], now });
  }
  const flights = new Map<string, Flight>();
  const hasToken = (): boolean => readSettings(deps.db, deps.config).lichessToken !== null;
  const headersMs = deps.timeouts?.headersMs ?? UPSTREAM_HEADERS_TIMEOUT_MS;
  const bodyMs = deps.timeouts?.bodyMs ?? UPSTREAM_BODY_TIMEOUT_MS;

  const fromEntry = (kind: CacheKind, e: CacheEntry, outcome: CacheOutcome): ProxyResult => ({
    status: e.status,
    body: e.body,
    contentType: CONTENT_TYPES[kind],
    cache: outcome,
  });

  /** The upstream call behind a flight (budget slot, fetch, cache write; stale on failure). */
  const run = async (req: UpstreamRequest, full: string, entry: CacheEntry | null, signal: AbortSignal): Promise<ProxyResult> => {
    const host = new URL(req.url).host;
    try {
      req.precheck?.();
      await req.budget.acquire(signal);
      const res = await deps.upstream.fetch(req.url, {
        auth: req.auth,
        timeoutMs: headersMs,
        signal: AbortSignal.any([signal, AbortSignal.timeout(bodyMs)]),
        allowStatuses: [...req.answers, 400, 401],
        headers: {
          accept: req.kind === 'masters-pgn' ? 'application/x-chess-pgn' : 'application/json',
          ...(entry?.etag ? { 'if-none-match': entry.etag } : {}),
        },
      });
      if (res.status === 304 && entry) {
        void res.body?.cancel().catch(() => {});
        cache.touch(full);
        return fromEntry(req.kind, entry, 'revalidated');
      }
      if (res.status === 304) throw new UpstreamError('status', host, `${host} answered 304 without a cached copy`, { status: 304 });
      const body = await readLimitedText(res, MAX_UPSTREAM_BODY_BYTES, host);
      if (res.status === 401) {
        if (req.auth === false) throw new NeedsToken();
        throw new HttpError(503, 'upstream_unavailable', 'Lichess rejected the API token; check it in the admin settings', {
          reason: 'token_rejected',
          host,
        });
      }
      if (res.status === 400) {
        throw new HttpError(400, 'bad_request', `${host}: ${excerpt(body) || 'bad request'}`);
      }
      if (res.status === 200 && CONTENT_TYPES[req.kind] === JSON_TYPE) {
        try {
          JSON.parse(body);
        } catch (e) {
          throw new UpstreamError('status', host, `Invalid JSON from ${host}`, { status: res.status, cause: e });
        }
      }
      const result: ProxyResult = { status: res.status, body, contentType: CONTENT_TYPES[req.kind], cache: 'miss' };
      cache.put(full, { status: res.status, body, contentType: result.contentType, etag: res.headers.get('etag') });
      return result;
    } catch (e) {
      const usable = entry !== null && freshness(req.kind, entry, now()) !== 'expired';
      const clientError = e instanceof HttpError && e.statusCode === 400;
      if (usable && !isAbort(e) && !clientError && !(e instanceof NeedsToken)) {
        deps.log?.warn({ err: e, key: full }, 'explorer proxy: serving a stale cached answer');
        return fromEntry(req.kind, entry, 'stale');
      }
      throw e;
    }
  };

  /** Joins a flight; leaving (client disconnect) aborts it once nobody waits any more. */
  const join = (flight: Flight, signal?: AbortSignal): Promise<ProxyResult> => {
    flight.waiters++;
    return new Promise<ProxyResult>((resolve, reject) => {
      let settled = false;
      const leave = (): boolean => {
        if (settled) return false;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        flight.waiters--;
        return true;
      };
      const onAbort = (): void => {
        if (!leave()) return;
        if (flight.waiters === 0) flight.controller.abort();
        reject(new BudgetError('aborted', 'Request cancelled', now()));
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      flight.promise.then(
        v => {
          if (leave()) resolve(v);
        },
        (e: unknown) => {
          if (leave()) reject(e);
        },
      );
    });
  };

  const fetchCached = (req: UpstreamRequest, signal?: AbortSignal): Promise<ProxyResult> => {
    const full = cacheKey(req.kind, req.key);
    const entry = cache.get(full);
    if (entry && freshness(req.kind, entry, now()) === 'fresh') return Promise.resolve(fromEntry(req.kind, entry, 'hit'));
    let flight = flights.get(full);
    if (!flight) {
      const controller = new AbortController();
      const f: Flight = { controller, waiters: 0, promise: run(req, full, entry, controller.signal) };
      const done = (): void => {
        if (flights.get(full) === f) flights.delete(full);
      };
      f.promise.then(done, done);
      flights.set(full, f);
      flight = f;
    }
    return join(flight, signal).catch((e: unknown) => {
      throw proxyHttpErrorKeepTokenHint(e);
    });
  };

  /** Keeps NeedsToken as is (callers retry with the token); maps everything else. */
  const proxyHttpErrorKeepTokenHint = (e: unknown): unknown => (e instanceof NeedsToken ? e : proxyHttpError(e));

  /** Anonymous first; after a 401, once more with the token (on the token's budget) when one is configured. */
  const anonymousThenToken = async (req: Omit<UpstreamRequest, 'auth' | 'budget'>, signal?: AbortSignal): Promise<ProxyResult> => {
    try {
      return await fetchCached({ ...req, auth: false, budget: budgets.masters }, signal);
    } catch (e) {
      if (!(e instanceof NeedsToken)) throw e;
      if (!hasToken()) throw proxyHttpError(e);
      return fetchCached({ ...req, auth: 'required', budget: budgets.lichess }, signal).catch((err: unknown) => {
        throw proxyHttpError(err);
      });
    }
  };

  return {
    masters: (params, signal) =>
      anonymousThenToken({ kind: 'masters', key: params.toString(), url: `${UPSTREAM.explorer}/masters?${params}`, answers: [] }, signal),

    mastersPgn: (id, signal) =>
      anonymousThenToken(
        { kind: 'masters-pgn', key: id, url: `${UPSTREAM.explorer}/masters/pgn/${encodeURIComponent(id)}`, answers: [404] },
        signal,
      ),

    lichess: (params, signal) =>
      fetchCached(
        {
          kind: 'lichess',
          key: params.toString(),
          url: `${UPSTREAM.explorer}/lichess?${params}`,
          budget: budgets.lichess,
          auth: 'required',
          answers: [],
          precheck: () => {
            if (!hasToken()) {
              throw new HttpError(
                503,
                'upstream_unavailable',
                'The Lichess opening explorer needs a Lichess API token: set LICHESS_TOKEN or add one in the admin settings',
                { reason: 'no_token' },
              );
            }
          },
        },
        signal,
      ).catch((e: unknown) => {
        throw proxyHttpError(e);
      }),

    tablebase: (variant, fen, signal) =>
      fetchCached(
        {
          kind: 'tablebase',
          key: `${variant}:${fen}`,
          url: `${UPSTREAM.tablebase}/${encodeURIComponent(variant)}?${new URLSearchParams({ fen })}`,
          budget: budgets.tablebase,
          auth: false,
          answers: [],
        },
        signal,
      ).catch((e: unknown) => {
        throw proxyHttpError(e);
      }),

    cloudEval: (q, signal) => {
      const params = new URLSearchParams({ fen: q.fen, multiPv: String(q.multiPv) });
      if (q.variant && q.variant !== 'standard') params.set('variant', q.variant);
      return fetchCached(
        {
          kind: 'cloud-eval',
          key: params.toString(),
          url: `${UPSTREAM.lichess}/api/cloud-eval?${params}`,
          budget: budgets.cloudEval,
          auth: false,
          answers: [404],
        },
        signal,
      ).catch((e: unknown) => {
        throw proxyHttpError(e);
      });
    },

    budget: name => budgets[name],
    cache,
  };
}
