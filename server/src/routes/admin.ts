import type { FastifyPluginAsync } from 'fastify';

/**
 * Admin routes — PLAN §6 "Session, account and admin" (admin settings, users, invites, status), §3 (env wins over UI settings), §10.
 *
 * Endpoints (request/response types in @outpost/shared/api):
 *   - GET/PUT /api/admin/settings (AdminSettings / UpdateAdminSettingsRequest → AdminSettings; write via src/settings.ts; null clears lichessToken / chesscomContact)
 *   - GET /api/admin/users (AdminUsersResponse)
 *   - PATCH/DELETE /api/admin/users/:id (UpdateAdminUserRequest → AdminUser / OkResponse)
 *   - GET/POST /api/admin/invites (InvitesResponse / CreateInviteRequest → Invite)
 *   - DELETE /api/admin/invites/:code (→ OkResponse)
 *   - GET /api/admin/status (AdminStatus; probes and the token check go through app.upstream)
 *
 * Every route: { preHandler: requireAdmin }. Job admin endpoints live in routes/jobs.ts, reference admin endpoints in routes/reference.ts.
 *
 * TODO(auth): implement. Keep this file thin: validate with src/http/validate.ts, check access
 * with the preHandlers in src/auth/session.ts, call into the module, return contract types, and
 * throw HttpError (src/http/errors.ts) for failures. Build paths from API_ROUTES (pass ':param'
 * placeholders, e.g. API_ROUTES.profile(':slug')).
 */
const adminRoutes: FastifyPluginAsync = async _app => {
  // TODO(auth)
};

export default adminRoutes;
