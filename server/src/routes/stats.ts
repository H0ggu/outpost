import { Readable } from 'node:stream';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  API_ROUTES,
  type ActivityStats,
  type BehaviourStats,
  type GamesPage,
  type OpeningsResponse,
  type OpponentsPage,
  type OverviewStats,
  type RatingStats,
  type WorldMapStats,
} from '@outpost/shared/api';
import { requireViewer } from '../auth/session.ts';
import { getOpeningBook } from '../chess/openings.ts';
import { validationError } from '../http/errors.ts';
import { pageQuery, parseFiltersQuery, parseParams, parseQuery, slugParams } from '../http/validate.ts';
import { loadProfileForViewer, type ViewableProfile } from '../profiles/access.ts';
import {
  activityStats,
  behaviourStats,
  GAMES_MAX_PAGE_SIZE,
  GAMES_PAGE_SIZE,
  gamesPage,
  OPENINGS_MAX_MOVES,
  openingsStats,
  OPPONENTS_MAX_PAGE_SIZE,
  OPPONENTS_PAGE_SIZE,
  opponentsPage,
  overviewStats,
  prepareProfilePgnExport,
  ratingStats,
  resolveTimeZone,
  worldMapStats,
  type StatsScope,
} from '../stats/index.ts';

/**
 * Stats routes — PLAN §6 "Stats" (every endpoint takes the ProfileFilters query), §4 player_games.
 *
 * Endpoints (request/response types in @outpost/shared/api):
 *   - GET /api/profiles/:slug/overview (OverviewStats)
 *   - GET /api/profiles/:slug/games (GamesQuery → GamesPage, pageSize 20)
 *   - GET /api/profiles/:slug/games.pgn (streamed application/x-chess-pgn, max 10,000 games, the
 *     profile's side named after the profile; `X-Outpost-Total` / `X-Outpost-Exported` headers)
 *   - GET /api/profiles/:slug/openings (OpeningsQuery → OpeningsResponse)
 *   - GET /api/profiles/:slug/opponents (OpponentsQuery → OpponentsPage)
 *   - GET /api/profiles/:slug/behaviour (BehaviourStats)
 *   - GET /api/profiles/:slug/worldmap (WorldMapStats)
 *   - GET /api/profiles/:slug/activity (ActivityQuery → ActivityStats)
 *   - GET /api/profiles/:slug/rating (RatingQuery → RatingStats)
 *
 * Every route: requireViewer, then loadProfileForViewer (404 for private profiles of others; hidden
 * sources only for editors); filters through playerGamesWhere (src/stats/filterSql.ts). The
 * queries live in src/stats/.
 */

const boundedInt = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

const openingsParams = z
  .object({
    side: z.enum(['white', 'black', 'both']).default('both'),
    order: z.enum(['most', 'best', 'worst']).default('most'),
    minGames: boundedInt(1, 1_000_000).optional(),
    minMoves: boundedInt(1, OPENINGS_MAX_MOVES).optional(),
    maxMoves: boundedInt(1, OPENINGS_MAX_MOVES).optional(),
  })
  .refine(p => p.minMoves === undefined || p.maxMoves === undefined || p.minMoves <= p.maxMoves, {
    message: '`minMoves` must not be greater than `maxMoves`',
    path: ['minMoves'],
  });

const opponentsParams = pageQuery(OPPONENTS_PAGE_SIZE, OPPONENTS_MAX_PAGE_SIZE).extend({
  view: z.enum(['most', 'titled']).default('most'),
});

const activityParams = z.object({ tz: z.string().max(200).default('UTC') });

const statsRoutes: FastifyPluginAsync = async app => {
  const book = () => getOpeningBook(app.config.openingsDir);

  /** The profile and the stats scope of a request (404 / 400 on failure). */
  const scopeOf = (req: FastifyRequest): { profile: ViewableProfile; scope: StatsScope } => {
    const { slug } = parseParams(slugParams, req.params);
    const profile = loadProfileForViewer(app.db, slug, req.user);
    const filters = parseFiltersQuery(req.query);
    return { profile, scope: { db: app.db, sourceIds: profile.sourceIds, filters } };
  };
  const opts = { preHandler: requireViewer };

  app.get(API_ROUTES.stats.overview(':slug'), opts, async (req): Promise<OverviewStats> => overviewStats(scopeOf(req).scope, book()));

  app.get(API_ROUTES.stats.games(':slug'), opts, async (req): Promise<GamesPage> => {
    const { scope } = scopeOf(req);
    const { page, pageSize } = parseQuery(pageQuery(GAMES_PAGE_SIZE, GAMES_MAX_PAGE_SIZE), req.query);
    return gamesPage(scope, page, pageSize);
  });

  app.get(API_ROUTES.stats.gamesPgn(':slug'), opts, async (req, reply) => {
    const { profile, scope } = scopeOf(req);
    const exp = prepareProfilePgnExport(scope, profile.displayName);
    return reply
      .type('application/x-chess-pgn; charset=utf-8')
      .header('content-disposition', `attachment; filename="${profile.slug}.pgn"`)
      .header('cache-control', 'no-store')
      .header('x-outpost-total', String(exp.total))
      .header('x-outpost-exported', String(exp.exported))
      .send(Readable.from(exp.chunks(), { objectMode: false }));
  });

  app.get(API_ROUTES.stats.openings(':slug'), opts, async (req): Promise<OpeningsResponse> => {
    const { scope } = scopeOf(req);
    const p = parseQuery(openingsParams, req.query);
    return openingsStats(scope, p, book());
  });

  app.get(API_ROUTES.stats.opponents(':slug'), opts, async (req): Promise<OpponentsPage> => {
    const { scope } = scopeOf(req);
    const p = parseQuery(opponentsParams, req.query);
    return opponentsPage(scope, { ...p, viewer: req.user });
  });

  app.get(API_ROUTES.stats.behaviour(':slug'), opts, async (req): Promise<BehaviourStats> => behaviourStats(scopeOf(req).scope));

  app.get(API_ROUTES.stats.worldmap(':slug'), opts, async (req): Promise<WorldMapStats> => worldMapStats(scopeOf(req).scope));

  app.get(API_ROUTES.stats.activity(':slug'), opts, async (req): Promise<ActivityStats> => {
    const { scope } = scopeOf(req);
    const { tz } = parseQuery(activityParams, req.query);
    const zone = resolveTimeZone(tz);
    if (zone === null) throw validationError('tz: not a known IANA time zone', { issues: [{ path: 'tz', message: 'unknown time zone' }] });
    return activityStats(scope, zone);
  });

  app.get(API_ROUTES.stats.rating(':slug'), opts, async (req): Promise<RatingStats> => ratingStats(scopeOf(req).scope));
};

export default statsRoutes;
