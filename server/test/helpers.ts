/**
 * Test helpers: a fresh app on a migrated temp database. Every test file gets its own data dir.
 *
 *   const t = await makeTestApp();
 *   const res = await t.app.inject({ method: 'GET', url: '/api/health' });
 *   await t.close();
 *
 * Tests have no network: `app.upstream` uses a fetch that throws unless you pass
 * `makeTestApp({ fetch })`. Workers never run (`config.startWorkers` is false under NODE_ENV=test):
 * run a job handler directly with `makeJobContext()`. Seed games with `insertGame(db, testGame())`.
 *
 * Note: serving files through @fastify/static under app.inject() prints a harmless
 * MaxListenersExceededWarning (light-my-request's Response); it does not happen over real HTTP.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Id, JobKind, JobPayloads, JobProgress } from '@outpost/shared/api';
import { buildApp } from '../src/app.ts';
import { hashSessionToken, SESSION_COOKIE } from '../src/auth/session.ts';
import type { NormalizedGame, NormalizedPlayer } from '../src/chess/store.ts';
import { loadConfig, type Config } from '../src/config.ts';
import { openDb, type Db } from '../src/db/index.ts';
import { migrate } from '../src/db/migrate.ts';
import { laneFor } from '../src/jobs/queue.ts';
import type { JobContext } from '../src/jobs/handlers.ts';

export interface TestApp {
  app: FastifyInstance;
  db: Db;
  config: Config;
  dir: string;
  close(): Promise<void>;
}

/** Headers for a state-changing request that passes the CSRF/Origin check under app.inject. */
export const mutationHeaders = { 'x-outpost': '1', origin: 'http://localhost:80', host: 'localhost:80' } as const;

/** The default fetch of test apps: no network. */
export const noNetworkFetch: typeof globalThis.fetch = async input => {
  throw new Error(`Network access is disabled in tests (${String(input)}); pass makeTestApp({ fetch })`);
};

/**
 * Builds an app on a temp DATA_DIR. `webDist: true` creates a fake web/dist build; `fetch` replaces
 * the network for `app.upstream` (default: `noNetworkFetch`).
 */
export async function makeTestApp(
  opts: { env?: Record<string, string>; webDist?: boolean; fetch?: typeof globalThis.fetch } = {},
): Promise<TestApp> {
  const dir = mkdtempSync(join(tmpdir(), 'outpost-test-'));
  const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: dir, LOG_LEVEL: 'silent', ...opts.env });
  config.webDistDir = join(dir, 'web-dist');
  if (opts.webDist) {
    mkdirSync(join(config.webDistDir, 'assets'), { recursive: true });
    writeFileSync(join(config.webDistDir, 'index.html'), '<!doctype html><title>Outpost</title><div id="root"></div>');
    writeFileSync(join(config.webDistDir, 'studio.html'), '<!doctype html><title>Studio</title><main class="analyse"></main>');
    writeFileSync(join(config.webDistDir, 'assets', 'app-abc123.js'), 'console.log("app");'.repeat(100));
  }
  const db = openDb(config.dbPath);
  migrate(db);
  const app = await buildApp({ config, db, logger: false, fetch: opts.fetch ?? noNetworkFetch });
  await app.ready();
  return {
    app,
    db,
    config,
    dir,
    async close() {
      await app.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Inserts a user and a live session; returns the cookie header value. */
export function createUserSession(
  db: Db,
  user: { username: string; role?: 'admin' | 'user'; disabled?: boolean },
): { userId: number; cookie: string } {
  const now = Date.now();
  const { lastInsertRowid: userId } = db.run(
    'INSERT INTO users (username, password_hash, role, disabled, created_at) VALUES (?, ?, ?, ?, ?)',
    [user.username, 'test-hash', user.role ?? 'user', user.disabled ?? false, now],
  );
  const token = randomBytes(32).toString('base64url');
  db.run(
    'INSERT INTO sessions (id_hash, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)',
    [hashSessionToken(token), userId, now, now + 86_400_000, now],
  );
  return { userId, cookie: `${SESSION_COOKIE}=${token}` };
}

/**
 * A `JobContext` for calling a job handler directly in a test (workers don't run in tests).
 * `updates` collects every `ctx.progress()` call; `abort()` fires `ctx.signal`.
 */
export function makeJobContext<K extends JobKind>(
  t: TestApp,
  kind: K,
  payload: JobPayloads[K],
  opts: { jobId?: Id; userId?: Id | null } = {},
): { ctx: JobContext<K>; updates: JobProgress[]; abort(): void } {
  const updates: JobProgress[] = [];
  const controller = new AbortController();
  const ctx: JobContext<K> = {
    job: { id: opts.jobId ?? 0, kind, lane: laneFor(t.db, kind, payload), payload, userId: opts.userId ?? null, attempts: 1 },
    db: t.db,
    config: t.config,
    upstream: t.app.upstream,
    log: t.app.log,
    signal: controller.signal,
    progress: p => void updates.push(p),
  };
  return { ctx, updates, abort: () => controller.abort() };
}

let gameSeq = 0;

/** Overrides for `testGame`; players are merged field by field. */
export type TestGameOverrides = Omit<Partial<NormalizedGame>, 'white' | 'black'> & {
  white?: Partial<NormalizedPlayer>;
  black?: Partial<NormalizedPlayer>;
};

/**
 * A synthetic Lichess game for seeding (`insertGame(t.db, testGame({...}))`): alice (1500) beats
 * bob (1500) by resignation in a blitz Ruy Lopez, 1 Jan 2026, unique `originId` per call.
 */
export function testGame(over: TestGameOverrides = {}): NormalizedGame {
  const n = ++gameSeq;
  const { white, black, ...rest } = over;
  const player = (name: string, p: Partial<NormalizedPlayer> = {}): NormalizedPlayer => ({
    name,
    rating: 1500,
    ratingAfter: null,
    title: null,
    fideId: null,
    accuracy: null,
    ...p,
  });
  const startedAt = Date.UTC(2026, 0, 1, 12) + n * 60_000;
  return {
    origin: 'lichess',
    originId: `test${n}`,
    url: null,
    databaseId: null,
    white: player('alice', white),
    black: player('bob', black),
    result: '1-0',
    termination: 'resign',
    timeClass: 'blitz',
    timeControl: '180+2',
    rated: true,
    event: null,
    round: null,
    startedAt,
    endedAt: startedAt + 10 * 60_000,
    moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6'],
    headers: null,
    ...rest,
  };
}

/** Inserts a source row; returns its id. */
export function createSource(
  db: Db,
  src: { kind: 'lichess' | 'chesscom' | 'fide' | 'pgn'; key: string; displayName?: string; databaseId?: Id | null },
): Id {
  return db.run('INSERT INTO sources (kind, key, display_name, database_id, created_at) VALUES (?, ?, ?, ?, ?)', [
    src.kind,
    src.key,
    src.displayName ?? src.key,
    src.databaseId ?? null,
    Date.now(),
  ]).lastInsertRowid;
}
