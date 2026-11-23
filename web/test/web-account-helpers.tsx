/**
 * Test harness of the web-account tests: a fake `fetch` that routes `METHOD /path` to handlers
 * (so the real `api` client, hooks and pages run end to end), contract-typed fixtures, and a
 * renderer with a fresh QueryClient and a memory router (optionally inside the real Layout).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { createMemoryRouter, Outlet, RouterProvider, type RouteObject } from 'react-router';
import { afterEach, beforeEach, vi } from 'vitest';
import {
  DEFAULT_PREFS,
  type AdminSettings,
  type AdminStatus,
  type AdminUser,
  type ApiErrorCode,
  type DatabaseInfo,
  type Invite,
  type JobInfo,
  type SessionInfo,
  type SessionRow,
  type SessionUser,
} from '@outpost/shared/api';
import Layout from '../src/app/Layout.tsx';

/** What a handler sees. */
export interface FakeRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  /** Parsed JSON body, a FormData, or the raw string. */
  body: unknown;
  headers: Headers;
}

type Handler = (req: FakeRequest) => unknown;

/**
 * Resolves to `value` after `ms` (a slow server answer). Real browsers see network latency between
 * a cache update and the refetch that follows it; without it jsdom tests can miss lost callbacks.
 */
export const later = <T,>(ms: number, value: T): Promise<T> => new Promise(resolve => setTimeout(() => resolve(value), ms));

/** JSON response. */
export const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** The server's error body (`details` optional). */
export const apiError = (status: number, code: ApiErrorCode, message: string = code, details?: unknown): Response =>
  json(status, { error: details === undefined ? { code, message } : { code, message, details } });

/** A fake API server: `api().on('GET', '/api/x', value | handler)`; unknown routes answer 404. */
export class FakeApi {
  readonly calls: FakeRequest[] = [];
  private routes: Array<{ method: string; path: string | RegExp; handler: Handler }> = [];

  /** A handler, or a fixed answer (a value sent as JSON, or a Response). Later registrations win. */
  on(method: string, path: string | RegExp, handler: (req: FakeRequest) => unknown): this;
  on(method: string, path: string | RegExp, value: object): this;
  on(method: string, path: string | RegExp, handler: unknown): this {
    const h: Handler =
      typeof handler === 'function'
        ? (handler as Handler)
        : handler instanceof Response
          ? () => (handler as Response).clone()
          : () => structuredClone(handler);
    this.routes.unshift({ method, path, handler: h });
    return this;
  }

  find(method: string, path: string | RegExp): FakeRequest[] {
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
    const req: FakeRequest = { method, path: url.pathname, query: url.searchParams, body, headers: new Headers(init.headers) };
    this.calls.push(req);
    const route = this.routes.find(r => r.method === method && (typeof r.path === 'string' ? r.path === url.pathname : r.path.test(url.pathname)));
    if (!route) return apiError(404, 'not_found', `No fake for ${method} ${url.pathname}`);
    const out = await route.handler(req);
    if (out instanceof Response) return out;
    if (out === undefined) return new Response(null, { status: 204 });
    return json(200, out);
  });
}

/** Installs a fresh fake API as `fetch` before each test and cleans up after. */
export function withFakeApi(): () => FakeApi {
  let server: FakeApi | undefined;
  beforeEach(() => {
    server = new FakeApi();
    vi.stubGlobal('fetch', server.fetch);
    document.documentElement.removeAttribute('data-theme');
    try {
      localStorage.clear();
    } catch {
      // no storage
    }
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  return () => server!;
}

/** Renders `element` at `path` (route pattern `route`), optionally inside the real site Layout. */
export function renderAt(
  element: ReactElement,
  { path = '/', route = '*', layout = false, extraRoutes = [] }: { path?: string; route?: string; layout?: boolean; extraRoutes?: RouteObject[] } = {},
) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity }, mutations: { retry: false } },
  });
  // A splat does not match the root itself, so `*` also gets an index route.
  const children: RouteObject[] = [...extraRoutes, ...(route === '*' ? [{ index: true, element }] : []), { path: route, element }];
  const router = createMemoryRouter([{ path: '/', element: layout ? <Layout /> : <Outlet />, children }], { initialEntries: [path] });
  const utils = render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...utils, router, qc, location: () => `${router.state.location.pathname}${router.state.location.search}` };
}

// ---------------------------------------------------------------------------
// Fixtures (shapes from @outpost/shared/api)
// ---------------------------------------------------------------------------

export const NOW = Date.UTC(2026, 10, 23, 12, 0, 0);

export const user = (o: Partial<SessionUser> = {}): SessionUser => ({
  id: 2,
  username: 'alice',
  role: 'user',
  totpEnabled: false,
  prefs: { ...DEFAULT_PREFS },
  ...o,
});

export const ADMIN = user({ id: 1, username: 'root', role: 'admin' });

export const session = (u: SessionUser | null, o: Partial<SessionInfo> = {}): SessionInfo => ({
  user: u,
  setupRequired: false,
  signupMode: 'invite',
  anonymousBrowsing: false,
  version: '0.1.0',
  ...o,
});

export const job = (o: Partial<JobInfo> = {}): JobInfo => ({
  id: 1,
  kind: 'sync',
  lane: 'lichess',
  status: 'running',
  priority: 0,
  label: 'Sync lichess:drnykterstein',
  userId: 1,
  progress: { done: 3, total: 10, message: '2026-09', counts: { imported: 120 } },
  error: null,
  createdAt: NOW - 60_000,
  startedAt: NOW - 30_000,
  finishedAt: null,
  queuePosition: 0,
  ...o,
});

export const sessionRow = (o: Partial<SessionRow> = {}): SessionRow => ({
  id: 'aa',
  createdAt: NOW - 86_400_000,
  lastSeenAt: NOW - 60_000,
  expiresAt: NOW + 29 * 86_400_000,
  ip: '192.0.2.1',
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0',
  current: false,
  ...o,
});

export const adminSettings = (o: Partial<AdminSettings> = {}): AdminSettings => ({
  signupMode: 'invite',
  anonymousBrowsing: false,
  lichessToken: { set: true, masked: 'lip_…a1b2', fromEnv: false },
  chesscomContact: 'ops@example.org',
  chesscomContactFromEnv: false,
  autoRefreshHourUtc: 9,
  updateCooldownMinutes: 15,
  initialSyncMonths: 0,
  mastersSource: 'lichess',
  ...o,
});

export const adminStatus = (o: Partial<AdminStatus> = {}): AdminStatus => ({
  version: '0.1.0',
  nodeVersion: 'v26.13.1',
  sqliteVersion: '3.51.0',
  uptimeSec: 7200,
  dataDir: '/data',
  dbSizeBytes: 12_500_000,
  lichessToken: { configured: true, valid: true, userId: 'bot', scopes: ['study:read'] },
  upstream: [
    { name: 'lichess', url: 'https://lichess.org/api', ok: true, status: 200, latencyMs: 80, error: null },
    { name: 'chesscom', url: 'https://api.chess.com/pub', ok: false, status: null, latencyMs: null, error: 'timeout' },
  ],
  counts: { users: 3, profiles: 5, sources: 7, games: 1234, referenceGames: 50_000, positions: 99_000, queuedJobs: 2 },
  ...o,
});

export const adminUser = (o: Partial<AdminUser> = {}): AdminUser => ({
  id: 2,
  username: 'alice',
  role: 'user',
  disabled: false,
  totpEnabled: false,
  createdAt: NOW - 10 * 86_400_000,
  lastSeenAt: NOW - 3_600_000,
  profileCount: 2,
  ...o,
});

export const invite = (o: Partial<Invite> = {}): Invite => ({
  code: 'abc123',
  createdBy: { id: 1, username: 'root' },
  createdAt: NOW - 86_400_000,
  expiresAt: null,
  usedBy: null,
  usedAt: null,
  ...o,
});

export const referenceDb = (o: Partial<DatabaseInfo> = {}): DatabaseInfo => ({
  id: 1,
  name: 'Lichess broadcasts',
  kind: 'reference',
  visibility: 'public',
  owner: null,
  sourceLabel: 'Lichess broadcasts (database.lichess.org)',
  licence: 'CC BY-SA 4.0',
  createdAt: NOW - 30 * 86_400_000,
  gameCount: 120_000,
  canEdit: true,
  importJob: null,
  ...o,
});
