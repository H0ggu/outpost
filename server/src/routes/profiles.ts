import type { FastifyPluginAsync } from 'fastify';

/**
 * Profiles routes — PLAN §6 "Search and profiles", §4 (sources, profiles, profile_sources, bookmarks, profile_views), §10 access rules.
 *
 * Endpoints (request/response types in @outpost/shared/api):
 *   - GET /api/profiles?scope=mine|public|recent (ProfileListResponse)
 *   - POST /api/profiles (CreateProfileRequest → ProfileHeader)
 *   - GET/PATCH/DELETE /api/profiles/:slug (ProfileHeader / UpdateProfileRequest)
 *   - POST /api/profiles/:slug/sources (AddSourceRequest → ProfileHeader)
 *   - DELETE /api/profiles/:slug/sources/:sourceId
 *   - POST /api/profiles/:slug/update (ProfileUpdateResponse; 429 'cooldown' with details.retryAt)
 *   - GET /api/profiles/:slug/status (ProfileStatus)
 *   - PUT/DELETE /api/profiles/:slug/bookmark
 *   - GET /api/bookmarks (ProfileListResponse)
 *
 * Enqueue syncs through src/jobs/ (owned by sync+jobs); record views in profile_views.
 *
 * TODO(profiles): implement. Keep this file thin: validate with src/http/validate.ts, check access
 * with the preHandlers in src/auth/session.ts, call into the module, return contract types, and
 * throw HttpError (src/http/errors.ts) for failures. Build paths from API_ROUTES (pass ':param'
 * placeholders, e.g. API_ROUTES.profile(':slug')).
 */
const profileRoutes: FastifyPluginAsync = async _app => {
  // TODO(profiles)
};

export default profileRoutes;
