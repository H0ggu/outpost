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
export const ACCOUNT_CHECK_RATE_LIMIT = { max: 30, timeWindow: 60_000 } as const;

const sourceParams = z.object({ slug: slugParams.shape.slug, sourceId: zId });

const profileRoutes: FastifyPluginAsync = async app => {
  const anonymousViews = new AnonymousViews();
  const ctx = { db: app.db, config: app.config, upstream: app.upstream };
  const logError = (err: unknown): void => app.log.error({ err }, 'profile clean-up failed');

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
    recordView(app.db, profile, req.user, { views: anonymousViews, ip: req.ip });
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
    deleteProfile(app.db, loadProfileForViewer(app.db, slug, req.user), logError);
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
    const { profile } = removeProfileSource(app.db, loadProfileForViewer(app.db, slug, req.user), req.user!, sourceId, logError);
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
