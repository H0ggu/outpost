import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { API_ROUTES, fromExplorerGameId, type Id } from '@outpost/shared/api';
import { decodeFiltersSegment, type ProfileFilters } from '@outpost/shared/filters';
import { ZodError } from 'zod';
import { requireUser, requireViewer } from '../auth/session.ts';
import { errorBody, notFound, validationError, zodIssues } from '../http/errors.ts';
import { parseFiltersQuery, parseParams, parseQuery } from '../http/validate.ts';
import { clientKey } from '../explorer/budget.ts';
import { createLocalExplorer } from '../explorer/local.ts';
import {
  cloudEvalFen,
  cloudEvalQuerySchema,
  gamesQuerySchema,
  lichessQuerySchema,
  lichessUpstreamQuery,
  mastersPgnParamsSchema,
  mastersQuerySchema,
  mastersUpstreamQuery,
  playerQuerySchema,
  referenceQuerySchema,
  tablebaseFen,
  tablebaseParamsSchema,
  tablebaseQuerySchema,
} from '../explorer/params.ts';
import { gamePgn, loadPgnGame } from '../explorer/pgn.ts';
import { createExplorerProxy, type ProxyResult } from '../explorer/proxy.ts';
import { loadDatabaseForViewer } from '../profiles/access.ts';
import { readSettings } from '../settings.ts';

/**
 * Explorer and proxies routes — PLAN §6 "Games, explorer and proxies", §8.3 (lila explorer
 * endpoint), research lichess-api.md §3. Logic lives in src/explorer/.
 *
 *   - GET /api/explorer/player, /api/explorer/f/:filters/player — NDJSON, one ExplorerPlayerResponse line
 *   - GET /api/explorer/masters, /f/:filters/masters — proxy (cached 3 h), or the local reference DB
 *     when the admin set `mastersSource: reference:<dbId>`
 *   - GET /api/explorer/masters/pgn/:id — Lichess masters PGN (proxy), or `op<id>` from Outpost
 *   - GET /api/explorer/lichess, /f/:filters/lichess — proxy with the token (503 without one),
 *     20 requests/min with a FIFO queue
 *   - GET /api/explorer/reference, /f/:filters/reference — masters shape from the reference DBs
 *   - GET /api/explorer/games — ExplorerGamesPage
 *   - GET /api/tablebase/:variant — proxy, **no session** (lila omits credentials), per-IP limit
 *   - GET /api/cloud-eval — proxy, 404 passthrough
 *
 * Every lila database also answers under `/f/:filters/` because lila resolves `./<db>` against
 * the (filtered) endpoint. Proxied databases ignore the filters; the reference explorer applies
 * the neutral ones (dates, time classes, rated, event, line).
 *
 * Access: the player explorer and the games list read public profiles anonymously only with
 * anonymous browsing on (`requireViewer` + per-object checks); the Lichess explorer spends the
 * instance's token budget, so it needs a signed-in user.
 */
const MIN = '1 minute';

/** Aborts when the client goes away before the answer is sent (lila abandons stale fetches). */
function clientSignal(reply: FastifyReply): AbortSignal {
  const c = new AbortController();
  reply.raw.once('close', () => {
    if (!reply.raw.writableFinished) c.abort();
  });
  return c.signal;
}

/** Outpost filters from the `/f/:filters/` segment (empty without one). */
function segmentFilters(req: FastifyRequest): ProfileFilters {
  const seg = (req.params as { filters?: string }).filters;
  if (seg === undefined) return {};
  try {
    return decodeFiltersSegment(seg);
  } catch (e) {
    if (e instanceof ZodError) {
      const issues = zodIssues(e);
      throw validationError(`filters: ${issues[0] ? `${issues[0].path}: ${issues[0].message}` : 'invalid'}`, { issues });
    }
    throw validationError(`filters: ${(e as Error).message}`);
  }
}

/** Sends a proxied answer (a 404 answer becomes the uniform error body). */
function sendProxy(reply: FastifyReply, r: ProxyResult, cacheControl: string, notFoundMessage: string): FastifyReply {
  reply.header('x-outpost-cache', r.cache).header('cache-control', cacheControl);
  if (r.status === 404) return reply.status(404).send(errorBody('not_found', notFoundMessage));
  return reply.status(200).type(r.contentType).send(r.body);
}

const explorerRoutes: FastifyPluginAsync = async app => {
  const local = createLocalExplorer({ db: app.db, openingsDir: app.config.openingsDir });
  const proxy = createExplorerProxy({ db: app.db, config: app.config, upstream: app.upstream, log: app.log });
  const E = API_ROUTES.explorer;
  const filtered = (db: string): string => `${E.filteredBase(':filters')}${db}`;

  /** The reference DB behind the masters explorer, or null for Lichess (a missing DB falls back to Lichess). */
  const mastersReferenceDb = (): Id | null => {
    const source = readSettings(app.db, app.config).mastersSource;
    if (!source.startsWith('reference:')) return null;
    const id = Number(source.slice('reference:'.length));
    const kind = app.db.value<string>('SELECT kind FROM databases WHERE id = ?', [id]);
    if (kind === 'reference') return id;
    app.log.warn({ mastersSource: source }, 'masters explorer: the configured reference database is missing; using Lichess');
    return null;
  };

  // --- Player explorer (NDJSON) ---------------------------------------------------------------
  const player = async (req: FastifyRequest, reply: FastifyReply) => {
    const q = parseQuery(playerQuerySchema, req.query);
    const filters = segmentFilters(req);
    const res = local.player({ ...q, filters, viewer: req.user });
    return reply
      .header('cache-control', 'private, no-cache')
      .type('application/x-ndjson; charset=utf-8')
      .send(`${JSON.stringify(res)}\n`);
  };
  const localLimit = { rateLimit: { max: 300, timeWindow: MIN } };
  app.get(E.player, { preHandler: requireViewer, config: localLimit }, player);
  app.get(filtered('player'), { preHandler: requireViewer, config: localLimit }, player);

  // --- Reference explorer (masters shape) -----------------------------------------------------
  const reference = async (req: FastifyRequest, reply: FastifyReply) => {
    const q = parseQuery(referenceQuerySchema, req.query);
    const res = local.reference({ ...q, databaseId: null, filters: segmentFilters(req) });
    return reply.header('cache-control', 'private, max-age=60').send(res);
  };
  app.get(E.reference, { preHandler: requireViewer, config: localLimit }, reference);
  app.get(filtered('reference'), { preHandler: requireViewer, config: localLimit }, reference);

  // --- Masters --------------------------------------------------------------------------------
  const masters = async (req: FastifyRequest, reply: FastifyReply) => {
    const q = parseQuery(mastersQuerySchema, req.query);
    const refDb = mastersReferenceDb();
    if (refDb !== null) {
      const res = local.reference({ ...q, databaseId: refDb, filters: segmentFilters(req) });
      return reply.header('x-outpost-source', 'reference').header('cache-control', 'private, max-age=60').send(res);
    }
    segmentFilters(req); // still validate the segment
    const r = await proxy.masters(mastersUpstreamQuery(q), clientSignal(reply));
    return sendProxy(reply.header('x-outpost-source', 'lichess'), r, 'private, max-age=600', 'Not found');
  };
  const proxyLimit = { rateLimit: { max: 120, timeWindow: MIN } };
  app.get(E.masters, { preHandler: requireViewer, config: proxyLimit }, masters);
  app.get(filtered('masters'), { preHandler: requireViewer, config: proxyLimit }, masters);

  app.get(E.mastersPgn(':id'), { preHandler: requireViewer, config: proxyLimit }, async (req, reply) => {
    const { id } = parseParams(mastersPgnParamsSchema, req.params);
    const gameId = fromExplorerGameId(id);
    if (gameId !== null) {
      const game = loadPgnGame(app.db, gameId);
      if (!game || game.database_id === null) throw notFound('Game not found');
      loadDatabaseForViewer(app.db, game.database_id, req.user);
      return reply.header('cache-control', 'private, max-age=3600').type('application/x-chess-pgn; charset=utf-8').send(gamePgn(game));
    }
    const r = await proxy.mastersPgn(id, clientSignal(reply));
    return sendProxy(reply, r, 'private, max-age=86400', 'Masters game not found');
  });

  // --- Lichess (token) ------------------------------------------------------------------------
  const lichess = async (req: FastifyRequest, reply: FastifyReply) => {
    const q = parseQuery(lichessQuerySchema, req.query);
    segmentFilters(req);
    const r = await proxy.lichess(lichessUpstreamQuery(q), clientSignal(reply));
    return sendProxy(reply, r, 'private, max-age=600', 'Not found');
  };
  const lichessLimit = { rateLimit: { max: 60, timeWindow: MIN } };
  app.get(E.lichess, { preHandler: requireUser, config: lichessLimit }, lichess);
  app.get(filtered('lichess'), { preHandler: requireUser, config: lichessLimit }, lichess);

  // --- Games at a position --------------------------------------------------------------------
  app.get(E.games, { preHandler: requireViewer, config: localLimit }, async (req, reply) => {
    const q = parseQuery(gamesQuerySchema, req.query);
    const filters = parseFiltersQuery(req.query);
    const page = local.games({ ...q, filters, viewer: req.user });
    return reply.header('cache-control', 'private, no-cache').send(page);
  });

  // --- Tablebase (no session: lila sends no cookie) -------------------------------------------
  // The route limit counts every request (cache hits are cheap); the proxy also caps each
  // address's new upstream lookups (TABLEBASE_PER_CLIENT_PER_MIN), well below the instance budget.
  app.get(API_ROUTES.tablebase(':variant'), { config: { rateLimit: { max: 120, timeWindow: MIN } } }, async (req, reply) => {
    const { variant } = parseParams(tablebaseParamsSchema, req.params);
    const { fen } = parseQuery(tablebaseQuerySchema, req.query);
    const r = await proxy.tablebase(variant, tablebaseFen(variant, fen), clientSignal(reply), clientKey(req.ip));
    return sendProxy(reply, r, 'public, max-age=86400', 'Not found');
  });

  // --- Cloud eval -----------------------------------------------------------------------------
  app.get(API_ROUTES.cloudEval, { preHandler: requireViewer, config: { rateLimit: { max: 120, timeWindow: MIN } } }, async (req, reply) => {
    const q = parseQuery(cloudEvalQuerySchema, req.query);
    const variant = q.variant === undefined || q.variant === 'fromPosition' ? 'standard' : q.variant;
    const r = await proxy.cloudEval({ fen: cloudEvalFen(q.fen), multiPv: q.multiPv, variant }, clientSignal(reply));
    return sendProxy(reply, r, 'private, max-age=300', 'No cloud evaluation available for that position');
  });
};

export default explorerRoutes;
