/**
 * A JSON GET through `app.upstream` with one deadline for the whole exchange: `timeoutMs` of the
 * upstream client covers the response headers only, so a server that sends headers and then
 * stalls the body would hang the caller. Used by the account checks (src/profiles/sources.ts) and
 * the unified search (src/search/), which must answer quickly.
 */
import { UpstreamError, type Upstream, type UpstreamInit } from '../http/upstream.ts';

/** Options of `upstreamJsonWithin`. */
export interface JsonWithinOptions {
  /** Deadline for headers and body together. */
  timeoutMs: number;
  /** Caller cancellation (e.g. the HTTP request was closed). */
  signal?: AbortSignal | undefined;
  /** Statuses answered with `{status, body: null}` instead of an error (the body is discarded). */
  allowStatuses?: readonly number[];
  auth?: UpstreamInit['auth'];
}

/** Settles with `p`, or rejects with the signal's reason as soon as it aborts. */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal, onAbort: () => void): Promise<T> {
  if (signal.aborted) {
    onAbort();
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      onAbort();
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    p.then(
      v => {
        signal.removeEventListener('abort', abort);
        resolve(v);
      },
      e => {
        signal.removeEventListener('abort', abort);
        reject(e);
      },
    );
  });
}

/**
 * GETs `url` and parses its JSON body within `timeoutMs`. Throws `UpstreamError`: `timeout` when the
 * deadline passes (headers or body), `aborted` when `signal` fires, `status` for unexpected
 * statuses or invalid JSON, `network` / `rate_limited` as `app.upstream` does.
 */
export async function upstreamJsonWithin(
  upstream: Upstream,
  url: string | URL,
  opts: JsonWithinOptions,
): Promise<{ status: number; body: unknown }> {
  const host = new URL(url).host;
  const deadline = AbortSignal.timeout(opts.timeoutMs);
  const signal = opts.signal ? AbortSignal.any([deadline, opts.signal]) : deadline;
  const timedOut = (): boolean => deadline.aborted && !opts.signal?.aborted;
  const mapAbort = (cause: unknown): UpstreamError =>
    timedOut()
      ? new UpstreamError('timeout', host, `${host} did not answer within ${opts.timeoutMs} ms`, { cause })
      : new UpstreamError('aborted', host, `Request to ${host} was cancelled`, { cause });

  let res: Response;
  try {
    res = await upstream.fetch(url, {
      ...(opts.auth !== undefined ? { auth: opts.auth } : {}),
      ...(opts.allowStatuses ? { allowStatuses: [...opts.allowStatuses] } : {}),
      timeoutMs: opts.timeoutMs,
      signal,
      headers: { accept: 'application/json' },
    });
  } catch (e) {
    if (e instanceof UpstreamError && e.reason === 'aborted') throw mapAbort(e);
    throw e;
  }
  if (res.status < 200 || res.status >= 300) {
    void res.body?.cancel().catch(() => {});
    if (opts.allowStatuses?.includes(res.status)) return { status: res.status, body: null };
    throw new UpstreamError('status', host, `${host} answered ${res.status}`, { status: res.status });
  }
  let text: string;
  try {
    text = await untilAborted(res.text(), signal, () => void res.body?.cancel().catch(() => {}));
  } catch (e) {
    if (signal.aborted) throw mapAbort(e);
    throw new UpstreamError('network', host, `Could not read the answer of ${host}: ${e instanceof Error ? e.message : String(e)}`, {
      cause: e,
    });
  }
  try {
    return { status: res.status, body: JSON.parse(text) as unknown };
  } catch (e) {
    throw new UpstreamError('status', host, `Invalid JSON from ${host}`, { status: res.status, cause: e });
  }
}
