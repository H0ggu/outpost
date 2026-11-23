import type { FastifyPluginAsync } from 'fastify';

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
 * Sources (NewSourceInput): for `pgn`, `key` is the player's name as written in the PGN and
 * `databaseId` is required; store `sources.key = pgnSourceKey(databaseId, key)` (src/chess/store.ts,
 * never build it by hand) and `display_name = key`.
 * Enqueue syncs with enqueueSync / read their state with sourceSyncStatus (src/jobs/; never write
 * to `jobs` directly). Attaching a pgn/fide source to stored games: rebuildPlayerGames
 * (src/chess/store.ts) or an enqueued 'rebuild' job. Record views in profile_views.
 * Read access: loadProfileForViewer (src/profiles/access.ts, shared with stats and explorer).
 * Upstream lookups (Lichess/Chess.com user checks) go through app.upstream.
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
