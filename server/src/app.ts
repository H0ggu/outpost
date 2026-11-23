/**
 * buildApp(): the Fastify instance with cross-cutting plugins and one route plugin per area.
 *
 * Order matters:
 *   1. decorators (config, db, upstream, req.user) and the error handler — before any plugin, so every
 *      encapsulated route plugin inherits them;
 *   2. security headers + CSRF/Origin check (global hooks);
 *   3. cookie, multipart, rate-limit (opt-in per route), compression;
 *   4. /api/health and the route plugins in src/routes/;
 *   5. the built web app (web/dist) with SPA fallback, when it exists (never in development).
 *
 * Module agents only edit their own src/routes/<area>.ts and module folder; this file should not
 * need changes. Background work starts from a plugin via app.addHook('onReady') / ('onClose').
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import compress from '@fastify/compress';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyPluginAsync, type FastifyServerOptions } from 'fastify';
import { API_ROUTES, type HealthResponse } from '@outpost/shared/api';
import type { Config } from './config.ts';
import type { Db } from './db/index.ts';
import { errorBody, errorHandler } from './http/errors.ts';
import { LOG_SERIALIZERS } from './http/logging.ts';
import { registerCsrfCheck, registerSecurityHeaders } from './http/security.ts';
import { createUpstream } from './http/upstream.ts';
import adminRoutes from './routes/admin.ts';
import assetRoutes from './routes/assets.ts';
import authRoutes from './routes/auth.ts';
import broadcastRoutes from './routes/broadcasts.ts';
import databaseRoutes from './routes/databases.ts';
import explorerRoutes from './routes/explorer.ts';
import fileRoutes from './routes/files.ts';
import gameRoutes from './routes/games.ts';
import jobRoutes from './routes/jobs.ts';
import prepRoutes from './routes/prep.ts';
import profileRoutes from './routes/profiles.ts';
import referenceRoutes from './routes/reference.ts';
import searchRoutes from './routes/search.ts';
import statsRoutes from './routes/stats.ts';

const MB = 1024 * 1024;

/** Default JSON body limit; routes that accept pasted PGN raise it (`{ bodyLimit: 50 * MB }`). */
export const JSON_BODY_LIMIT = 1 * MB;
/** Multipart upload limit for PGN files (PLAN §10); the reference import raises it per request. */
export const PGN_UPLOAD_LIMIT = 50 * MB;

/** Route plugins, one per area (PLAN §2 `routes/`). */
export const ROUTE_PLUGINS: ReadonlyArray<readonly [string, FastifyPluginAsync]> = [
  ['auth', authRoutes],
  ['admin', adminRoutes],
  ['jobs', jobRoutes],
  ['search', searchRoutes],
  ['profiles', profileRoutes],
  ['stats', statsRoutes],
  ['games', gameRoutes],
  ['explorer', explorerRoutes],
  ['assets', assetRoutes],
  ['databases', databaseRoutes],
  ['files', fileRoutes],
  ['reference', referenceRoutes],
  ['broadcasts', broadcastRoutes],
  ['prep', prepRoutes],
];

/** Options for `buildApp`. */
export interface BuildAppOptions {
  config: Config;
  db: Db;
  /** Override the logger (tests pass `false`). Defaults to pino at `config.logLevel`. */
  logger?: FastifyServerOptions['logger'];
  /** fetch used by `app.upstream` (tests inject a fake). Defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
}

/** Builds the Fastify app. Call `app.listen()` (main.ts) or `app.inject()` (tests). */
export async function buildApp({ config, db, logger, fetch }: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    // Request lines never carry secret query parameters (invite links): http/logging.ts.
    logger: logger === false ? false : { level: config.logLevel, ...(typeof logger === 'object' ? logger : {}), serializers: LOG_SERIALIZERS },
    trustProxy: config.trustProxy,
    bodyLimit: JSON_BODY_LIMIT,
    // The explorer carries base64url filters in a path segment (/api/explorer/f/:filters/player).
    routerOptions: { maxParamLength: 5000 },
  });

  app.decorate('config', config);
  app.decorate('db', db);
  app.decorate('upstream', createUpstream({ config, db, ...(fetch ? { fetch } : {}) }));
  app.decorateRequest('user', null);
  app.decorateRequest('sessionHash', null);
  app.setErrorHandler(errorHandler);

  registerSecurityHeaders(app);
  registerCsrfCheck(app, config);

  await app.register(cookie);
  await app.register(multipart, {
    limits: { fileSize: PGN_UPLOAD_LIMIT, files: 1, fields: 20, fieldSize: 64 * 1024 },
  });
  await app.register(rateLimit, { global: false });
  await app.register(compress, { global: true, threshold: 1024, encodings: ['br', 'gzip'] });

  const startedAt = Date.now();
  app.get(API_ROUTES.health, async (): Promise<HealthResponse> => {
    db.get('SELECT 1 AS ok');
    return { status: 'ok', version: config.version, uptimeSec: Math.round((Date.now() - startedAt) / 1000) };
  });

  for (const [, plugin] of ROUTE_PLUGINS) await app.register(plugin);

  await registerWebUi(app, config);
  return app;
}

/** Paths never answered with the SPA shell. */
const NON_SPA_PREFIXES = ['/api/', '/assets/', '/lichess/'];

/** True for client-side routes: GET of an extension-less path outside the API and asset trees. */
export function isSpaPath(path: string): boolean {
  if (path === '/api' || NON_SPA_PREFIXES.some(p => path.startsWith(p))) return false;
  const last = path.slice(path.lastIndexOf('/') + 1);
  return !last.includes('.');
}

/**
 * Serves web/dist when it has been built: hashed /assets/* immutable, HTML no-cache,
 * /studio → studio.html, other client routes → index.html. Without a build, and always in
 * development (`config.webDistDir` is null), unknown paths get a JSON 404 and the Vite dev server
 * serves the UI.
 */
async function registerWebUi(app: FastifyInstance, config: Config): Promise<void> {
  const dist = config.webDistDir;
  const hasDist = dist !== null && existsSync(join(dist, 'index.html'));
  if (dist === null) {
    app.log.info('development: web/dist is not served here; open the Vite dev server (npm run dev, http://localhost:5173)');
  }

  if (hasDist) {
    await app.register(fastifyStatic, {
      root: dist,
      prefix: '/',
      index: false,
      wildcard: true,
      setHeaders(reply, filePath) {
        if (filePath.endsWith('.html')) reply.header('cache-control', 'no-cache');
        else if (filePath.startsWith(join(dist, 'assets'))) reply.header('cache-control', 'public, max-age=31536000, immutable');
        else reply.header('cache-control', 'public, max-age=86400');
      },
    });
    // `/` is a directory to @fastify/static (403 with index:false), so answer it explicitly.
    app.get('/', async (_req, reply) =>
      reply.header('cache-control', 'no-cache').type('text/html; charset=utf-8').sendFile('index.html'),
    );
    const studio = existsSync(join(dist, 'studio.html'));
    for (const path of ['/studio', '/studio/']) {
      app.get(path, async (_req, reply) => {
        if (!studio) return reply.status(404).send(errorBody('not_found', 'Studio not built'));
        return reply.header('cache-control', 'no-cache').sendFile('studio.html');
      });
    }
  }

  app.setNotFoundHandler(async (req, reply) => {
    const path = req.url.split('?')[0] ?? '/';
    if (hasDist && (req.method === 'GET' || req.method === 'HEAD') && isSpaPath(path)) {
      return reply.header('cache-control', 'no-cache').type('text/html; charset=utf-8').sendFile('index.html');
    }
    return reply.status(404).send(errorBody('not_found', `No route for ${req.method} ${path}`));
  });
}
