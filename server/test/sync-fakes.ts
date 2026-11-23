/**
 * Fake upstream for the jobs/sync tests: a `fetch` that answers from a route table and records
 * every call. Fixtures live in test/fixtures/{lichess,chesscom}:
 * - lichess/*: synthetic players and games (made-up names, shapes as in docs/research/lichess-api.md);
 * - chesscom/*: hikaru's public profile/stats and a few of his games (2014-04, 2026-10, 2026-11)
 *   with every opponent pseudonymised (Opponent01…, synthetic game/player ids).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const FIXTURES = join(import.meta.dirname, 'fixtures');

/** A fixture file's text. */
export const fixtureText = (path: string): string => readFileSync(join(FIXTURES, path), 'utf8');
/** A fixture file parsed as JSON. */
export const fixtureJson = <T = unknown>(path: string): T => JSON.parse(fixtureText(path)) as T;
/** A NDJSON fixture's lines parsed. */
export const fixtureNdjson = <T = unknown>(path: string): T[] =>
  fixtureText(path)
    .split('\n')
    .filter(l => l.trim())
    .map(l => JSON.parse(l) as T);

/** One recorded request. */
export interface FakeCall {
  method: string;
  url: URL;
  headers: Headers;
  body: string | null;
}

/** A route: returns a Response, or undefined to fall through to the next route. */
export type FakeRoute = (url: URL, call: FakeCall) => Response | Promise<Response> | undefined;

/** A fake fetch with its call log. */
export interface FakeFetch {
  fetch: typeof globalThis.fetch;
  calls: FakeCall[];
  /** Calls whose URL path matches. */
  callsTo(path: string | RegExp): FakeCall[];
}

/** Builds a fake fetch from routes keyed by `host + pathname` (string = exact, RegExp = test). */
export function fakeFetch(routes: Array<[string | RegExp, FakeRoute]>): FakeFetch {
  const calls: FakeCall[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const body = init?.body === undefined || init.body === null ? null : String(init.body);
    const call: FakeCall = { method: init?.method ?? 'GET', url, headers: new Headers(init?.headers), body };
    calls.push(call);
    if (init?.signal?.aborted) throw init.signal.reason ?? new Error('aborted');
    const key = `${url.host}${url.pathname}`;
    for (const [match, route] of routes) {
      if (typeof match === 'string' ? match === key : match.test(key)) {
        const res = await route(url, call);
        if (res) return res;
      }
    }
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
  };
  return {
    fetch,
    calls,
    callsTo: path => calls.filter(c => (typeof path === 'string' ? c.url.pathname === path : path.test(c.url.pathname))),
  };
}

/** A JSON response. */
export const jsonResponse = (body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response =>
  new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  });

/** An empty response with a status (304, 404, 429, 503 …). */
export const statusResponse = (status: number, headers: Record<string, string> = {}): Response =>
  new Response(status === 304 ? null : JSON.stringify({ code: 0, message: `status ${status}` }), { status, headers });

/**
 * A streamed NDJSON response. `failAfter` lines are sent, then the stream errors (a dropped
 * connection); `chunkSize` splits the text at arbitrary byte boundaries.
 */
export function ndjsonResponse(lines: readonly unknown[], opts: { failAfter?: number; chunkSize?: number } = {}): Response {
  const encoder = new TextEncoder();
  const sent = opts.failAfter === undefined ? lines : lines.slice(0, opts.failAfter);
  const bytes = encoder.encode(sent.map(l => `${JSON.stringify(l)}\n`).join(''));
  const size = opts.chunkSize ?? 512;
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset < bytes.length) {
        controller.enqueue(bytes.subarray(offset, offset + size));
        offset += size;
        return;
      }
      if (opts.failAfter !== undefined) controller.error(new TypeError('terminated'));
      else controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
}
