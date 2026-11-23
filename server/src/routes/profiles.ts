import type { FastifyPluginAsync } from 'fastify';
import {
  API_ROUTES,
  type BookmarkResponse,
  type OkResponse,
  type ProfileHeader,
  type ProfileListResponse,
  type ProfileStatus,
  type ProfileUpdateResponse,
} from '@outpost/shared/api';
import { z } from 'zod';
import { requireUser, requireViewer } from '../auth/session.ts';
import { parseBody, parseParams, parseQuery, slugParams, zId } from '../http/validate.ts';
import { loadProfileForViewer } from '../profiles/access.ts';
import {
  addProfileSource,
  AnonymousViews,
  type CleanupOptions,
  createProfile,
  createProfileSchema,
  deleteProfile,
  listBookmarks,
  listProfiles,
  newSourceSchema,
  profileHeader,
  profileListQuerySchema,
  profileStatus,
  recordView,
  removeProfileSource,
  requestUpdate,
  setBookmark,
  sweepOrphans,
  updateProfile,
  updateProfileSchema,
} from '../profiles/service.ts';

/**
 * Profiles routes — PLAN §6 "Search and profiles", §4 (sources, profiles, profile_sources, bookmarks, profile_views), §10 access rules.
 *
 * Endpoints (request/response types in @outpost/shared/api):
 *   - GET /api/profiles?scope=mine|public|recent (ProfileListResponse)
 *   - POST /api/profiles (CreateProfileRequest → ProfileHeader)
 *   - GET/PATCH/DELETE /api/profiles/:slug (ProfileHeader / UpdateProfileRequest → ProfileHeader / OkResponse)
 *   - POST /api/profiles/:slug/sources (AddSourceRequest → ProfileHeader)
 *   - DELETE /api/profiles/:slug/sources/:sourceId (→ ProfileHeader)
 *   - POST /api/profiles/:slug/update (ProfileUpdateResponse; 429 'cooldown' with details.retryAt)
 *   - GET /api/profiles/:slug/status (ProfileStatus)
 *   - PUT/DELETE /api/profiles/:slug/bookmark (→ BookmarkResponse)
 *   - GET /api/bookmarks (ProfileListResponse)
 *
 * Reads: requireViewer + loadProfileForViewer (404 for private profiles of others). Mutations:
 * requireUser, then owner or admin (403 otherwise). Logic and the orphan policy live in
 * src/profiles/service.ts; source checks (upstream through app.upstream) in src/profiles/sources.ts.
 */

/** Creating profiles and adding accounts call Lichess / Chess.com: throttled per IP. */
export const ACCOUNT_CHECK_RATE_LIMIT = { max: 60, timeWindow: 60_000 } as const;
/** How often the orphan sweep runs while the workers run (and once at startup). */
export const ORPHAN_SWEEP_EVERY_MS = 6 * 3_600_000;

const sourceParams = z.object({ slug: slugParams.shape.slug, sourceId: zId });

const profileRoutes: FastifyPluginAsync = async app => {
  const anonymousViews = new AnonymousViews();
  const ctx = { db: app.db, config: app.config, upstream: app.upstream };
  // Background clean-ups (large profile deletes, the orphan sweep) stop at shutdown; what they
  // leave is found by the next sweep.
  const stop = new AbortController();
  const pending = new Set<Promise<unknown>>();
  const track = (p: Promise<unknown>): void => {
    pending.add(p);
    void p.finally(() => pending.delete(p));
  };
  const cleanup: CleanupOptions = { log: err => app.log.error({ err }, 'profile clean-up failed'), signal: stop.signal };

  // The orphan policy for profiles deleted with their owner (src/profiles/service.ts). Background
  // work: only when this process runs the workers (never in tests).
  let sweepTimer: NodeJS.Timeout | null = null;
  let sweeping = false;
  const runSweep = (): void => {
    if (sweeping || stop.signal.aborted) return;
    sweeping = true;
    track(
      sweepOrphans(app.db, { scanGames: true, signal: stop.signal })
        .then(r => {
          if (r.sources || r.games) app.log.info(r, 'removed orphaned sources and games');
        })
        .catch(err => app.log.error({ err }, 'orphan sweep failed'))
        .finally(() => {
          sweeping = false;
        }),
    );
  };
  app.addHook('onReady', async () => {
    if (!app.config.startWorkers) return;
    runSweep();
    sweepTimer = setInterval(runSweep, ORPHAN_SWEEP_EVERY_MS);
    sweepTimer.unref();
  });
  app.addHook('onClose', async () => {
    stop.abort();
    if (sweepTimer) clearInterval(sweepTimer);
    await Promise.allSettled([...pending]);
  });

  app.get(API_ROUTES.profiles, { preHandler: requireViewer }, async (req): Promise<ProfileListResponse> => {
    const { scope } = parseQuery(profileListQuerySchema, req.query);
    return { profiles: listProfiles(app.db, scope ?? (req.user ? 'mine' : 'public'), req.user) };
  });

  app.post(
    API_ROUTES.profiles,
    { preHandler: requireUser, config: { rateLimit: ACCOUNT_CHECK_RATE_LIMIT } },
    async (req): Promise<ProfileHeader> => {
      const body = parseBody(createProfileSchema, req.body);
      const profile = await createProfile(ctx, req.user!, body);
      return profileHeader(app.db, app.config, profile, req.user);
    },
  );

  app.get(API_ROUTES.profile(':slug'), { preHandler: requireViewer }, async (req): Promise<ProfileHeader> => {
    const { slug } = parseParams(slugParams, req.params);
    const profile = loadProfileForViewer(app.db, slug, req.user);
    const header = profileHeader(app.db, app.config, profile, req.user);
    if (req.method === 'GET') recordView(app.db, profile, req.user, { views: anonymousViews, ip: req.ip });
    return header;
  });

  app.patch(API_ROUTES.profile(':slug'), { preHandler: requireUser }, async (req): Promise<ProfileHeader> => {
    const { slug } = parseParams(slugParams, req.params);
    const patch = parseBody(updateProfileSchema, req.body);
    const profile = updateProfile(app.db, loadProfileForViewer(app.db, slug, req.user), req.user!, patch);
    return profileHeader(app.db, app.config, profile, req.user);
  });

  app.delete(API_ROUTES.profile(':slug'), { preHandler: requireUser }, async (req): Promise<OkResponse> => {
    const { slug } = parseParams(slugParams, req.params);
    track(deleteProfile(app.db, loadProfileForViewer(app.db, slug, req.user), cleanup).cleanup);
    return { ok: true };
  });

  app.post(
    API_ROUTES.profileSources(':slug'),
    { preHandler: requireUser, config: { rateLimit: ACCOUNT_CHECK_RATE_LIMIT } },
    async (req): Promise<ProfileHeader> => {
      const { slug } = parseParams(slugParams, req.params);
      const input = parseBody(newSourceSchema, req.body);
      const profile = await addProfileSource(ctx, loadProfileForViewer(app.db, slug, req.user), req.user!, input);
      return profileHeader(app.db, app.config, profile, req.user);
    },
  );

  app.delete(API_ROUTES.profileSource(':slug', ':sourceId'), { preHandler: requireUser }, async (req): Promise<ProfileHeader> => {
    const { slug, sourceId } = parseParams(sourceParams, req.params);
    const removed = removeProfileSource(app.db, loadProfileForViewer(app.db, slug, req.user), req.user!, sourceId, cleanup);
    track(removed.cleanup);
    const { profile } = removed;
    return profileHeader(app.db, app.config, profile, req.user);
  });

  app.post(API_ROUTES.profileUpdate(':slug'), { preHandler: requireUser }, async (req): Promise<ProfileUpdateResponse> => {
    const { slug } = parseParams(slugParams, req.params);
    return requestUpdate(app.db, app.config, loadProfileForViewer(app.db, slug, req.user), req.user!);
  });

  app.get(API_ROUTES.profileStatus(':slug'), { preHandler: requireViewer }, async (req): Promise<ProfileStatus> => {
    const { slug } = parseParams(slugParams, req.params);
    return profileStatus(app.db, app.config, loadProfileForViewer(app.db, slug, req.user), req.user);
  });

  for (const [method, on] of [
    ['PUT', true],
    ['DELETE', false],
  ] as const) {
    app.route({
      method,
      url: API_ROUTES.profileBookmark(':slug'),
      preHandler: requireUser,
      handler: async (req): Promise<BookmarkResponse> => {
        const { slug } = parseParams(slugParams, req.params);
        return setBookmark(app.db, loadProfileForViewer(app.db, slug, req.user), req.user!, on);
      },
    });
  }

  app.get(API_ROUTES.bookmarks, { preHandler: requireUser }, async (req): Promise<ProfileListResponse> => ({
    profiles: listBookmarks(app.db, req.user!),
  }));
};

export default profileRoutes;
