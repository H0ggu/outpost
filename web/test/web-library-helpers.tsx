/**
 * Test harness of the web-library tests: a fake `fetch` routing `METHOD /path` to handlers (so the
 * real `api` client, hooks and pages run end to end), typed fixtures from the contract, and a page
 * renderer with a fresh QueryClient and a memory router that records where the page navigates.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { createMemoryRouter, Outlet, RouterProvider, useLocation, type RouteObject } from 'react-router';
import { afterEach, beforeEach, vi } from 'vitest';
import {
  DEFAULT_PREFS,
  type ApiErrorCode,
  type DatabaseInfo,
  type GameRow,
  type JobInfo,
  type ProfileHeader,
  type ProfileSummary,
  type SessionInfo,
  type SessionUser,
} from '@outpost/shared/api';

/** What a handler sees. */
export interface FakeRequest {
  method: string;
  url: URL;
  path: string;
  query: URLSearchParams;
  /** Parsed JSON body, the FormData, or the raw string. */
  body: unknown;
  headers: Headers;
}

/** A handler's answer: a Response, or any value sent as JSON 200. */
export type Handler = (req: FakeRequest) => unknown;

/** A recorded call. */
export type Call = FakeRequest;

/** JSON response with a status. */
export const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** The server's error body. */
export const apiError = (status: number, code: ApiErrorCode, message: string = code, details?: unknown): Response =>
  json(status, { error: { code, message, ...(details === undefined ? {} : { details }) } });

/** The server's answer when an endpoint needs the Lichess token and none is set (upstreamHttpError). */
export const noTokenError = (message = 'A Lichess API token is required: set LICHESS_TOKEN or add one in the admin settings'): Response =>
  apiError(503, 'upstream_unavailable', message, { host: 'lichess.org', reason: 'no_token' });

/** Plain-text response (PGN). */
export const text = (body: string, type = 'application/x-chess-pgn'): Response =>
  new Response(body, { status: 200, headers: { 'content-type': type } });

/** Fake API: `server.on('GET', '/api/x', handler)`; unknown routes answer 404 `not_found`. */
export class FakeServer {
  readonly calls: Call[] = [];
  private routes: Array<{ method: string; path: string | RegExp; handler: Handler }> = [];

  /** A handler, or a fixed answer (a value sent as JSON, or a Response). */
  on(method: string, path: string | RegExp, handler: Handler): this;
  on(method: string, path: string | RegExp, value: object): this;
  on(method: string, path: string | RegExp, handler: unknown): this {
    const h: Handler =
      typeof handler === 'function'
        ? (handler as Handler)
        : handler instanceof Response
          ? () => (handler as Response).clone()
          : () => handler;
    // Later registrations win, so a test can override a default.
    this.routes.unshift({ method, path, handler: h });
    return this;
  }

  /** Calls matching a method and path (exact string or RegExp). */
  find(method: string, path: string | RegExp): Call[] {
    return this.calls.filter(c => c.method === method && (typeof path === 'string' ? c.path === path : path.test(c.path)));
  }

  readonly fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost');
    const method = (init.method ?? 'GET').toUpperCase();
    let body: unknown = init.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        // raw text
      }
    }
    const req: FakeRequest = { method, url, path: url.pathname, query: url.searchParams, body, headers: new Headers(init.headers) };
    this.calls.push(req);
    const route = this.routes.find(
      r => r.method === method && (typeof r.path === 'string' ? r.path === url.pathname : r.path.test(url.pathname)),
    );
    if (!route) return apiError(404, 'not_found', `No fake for ${method} ${url.pathname}`);
    const out = await route.handler(req);
    if (out instanceof Response) return out;
    if (out === undefined) return new Response(null, { status: 204 });
    return json(200, out);
  });
}

/** Installs a fresh fake server as `fetch` (call in `beforeEach`). */
export function installServer(): FakeServer {
  const server = new FakeServer();
  vi.stubGlobal('fetch', server.fetch);
  return server;
}

/**
 * Registers the per-test hooks (fresh fake server before, DOM cleanup and unstubbing after) and
 * returns a getter for the current server: `const api = withFakeServer(); … api().on(…)`.
 */
export function withFakeServer(): () => FakeServer {
  let server: FakeServer | undefined;
  beforeEach(() => {
    server = installServer();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  return () => server!;
}

/** Records the router location (rendered above the page). */
function Shell() {
  const loc = useLocation();
  return (
    <>
      <div data-testid="location" hidden>{`${loc.pathname}${loc.search}`}</div>
      <Outlet />
    </>
  );
}

/** Renders `element` at `route` (a pattern), starting from `path`. Other paths render nothing. */
export function renderPage(element: ReactElement, { route = '/', path = route }: { route?: string; path?: string } = {}) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity }, mutations: { retry: false } },
  });
  const page: RouteObject = route === '/' ? { index: true, element } : { path: route.replace(/^\//, ''), element };
  const router = createMemoryRouter([{ path: '/', element: <Shell />, children: [page, { path: '*', element: null }] }], {
    initialEntries: [path],
  });
  const utils = render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...utils, router, qc, location: () => `${router.state.location.pathname}${router.state.location.search}` };
}

// ---------------------------------------------------------------------------
// Fixtures (synthetic; typed from the contract)
// ---------------------------------------------------------------------------

export const USER: SessionUser = { id: 1, username: 'alice', role: 'user', totpEnabled: false, prefs: { ...DEFAULT_PREFS } };
export const ADMIN: SessionUser = { ...USER, id: 9, username: 'root', role: 'admin' };

export const session = (user: SessionUser | null, over: Partial<SessionInfo> = {}): SessionInfo => ({
  user,
  setupRequired: false,
  signupMode: 'open',
  anonymousBrowsing: false,
  version: '0.1.0',
  ...over,
});

let nextId = 100;

export function profile(over: Partial<ProfileSummary> = {}): ProfileSummary {
  const id = over.id ?? nextId++;
  return {
    id,
    slug: `player-${id}`,
    displayName: `Player ${id}`,
    visibility: 'private',
    owner: { id: USER.id, username: USER.username },
    sources: [{ kind: 'lichess', key: `p${id}`, displayName: `p${id}`, title: null, country: null }],
    gameCount: 120,
    lastUpdated: Date.now() - 3_600_000,
    bookmarked: false,
    ...over,
  };
}

export function header(over: Partial<ProfileHeader> = {}): ProfileHeader {
  return {
    id: 501,
    slug: 'new-player',
    displayName: 'New Player',
    visibility: 'private',
    autoRefresh: false,
    owner: { id: USER.id, username: USER.username },
    canEdit: true,
    bookmarked: false,
    sources: [],
    totals: { w: 0, d: 0, l: 0, games: 0 },
    lastUpdated: null,
    queue: { busy: true, cooldownUntil: null, queuePosition: 1 },
    views: 0,
    createdAt: Date.now(),
    ...over,
  };
}

export function job(over: Partial<JobInfo> = {}): JobInfo {
  return {
    id: 77,
    kind: 'pgnImport',
    lane: 'local',
    status: 'queued',
    priority: 0,
    label: 'Import games.pgn',
    userId: USER.id,
    progress: null,
    error: null,
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    queuePosition: 1,
    ...over,
  };
}

export function database(over: Partial<DatabaseInfo> = {}): DatabaseInfo {
  return {
    id: 5,
    name: 'Club games',
    kind: 'games',
    visibility: 'private',
    owner: { id: USER.id, username: USER.username },
    sourceLabel: null,
    licence: null,
    createdAt: Date.now() - 86_400_000,
    gameCount: 3,
    canEdit: true,
    importJob: null,
    ...over,
  };
}

export function gameRow(over: Partial<GameRow> = {}): GameRow {
  const id = over.id ?? nextId++;
  return {
    id,
    origin: 'lichess',
    url: null,
    sourceId: 1,
    color: 'white',
    outcome: 'w',
    result: '1-0',
    termination: 'resign',
    timeClass: 'blitz',
    timeControl: '180+2',
    rated: true,
    startedAt: Date.now() - 86_400_000,
    endedAt: Date.now() - 86_000_000,
    rating: 2000,
    ratingAfter: 2008,
    opponent: { name: 'Opponent', key: 'opponent', rating: 1990, title: null, kind: 'lichess', country: null },
    plies: 60,
    eco: 'B90',
    openingName: 'Sicilian Defense: Najdorf Variation',
    accuracy: null,
    event: null,
    ...over,
  };
}
