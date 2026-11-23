/**
 * Test helpers: a fresh app on a migrated temp database. Every test file gets its own data dir.
 *
 *   const t = await makeTestApp();
 *   const res = await t.app.inject({ method: 'GET', url: '/api/health' });
 *   await t.close();
 *
 * Note: serving files through @fastify/static under app.inject() prints a harmless
 * MaxListenersExceededWarning (light-my-request's Response); it does not happen over real HTTP.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { hashSessionToken, SESSION_COOKIE } from '../src/auth/session.ts';
import { loadConfig, type Config } from '../src/config.ts';
import { openDb, type Db } from '../src/db/index.ts';
import { migrate } from '../src/db/migrate.ts';

export interface TestApp {
  app: FastifyInstance;
  db: Db;
  config: Config;
  dir: string;
  close(): Promise<void>;
}

/** Headers for a state-changing request that passes the CSRF/Origin check under app.inject. */
export const mutationHeaders = { 'x-outpost': '1', origin: 'http://localhost:80', host: 'localhost:80' } as const;

/** Builds an app on a temp DATA_DIR. `webDist: true` creates a fake web/dist build. */
export async function makeTestApp(
  opts: { env?: Record<string, string>; webDist?: boolean } = {},
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
  const app = await buildApp({ config, db, logger: false });
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
