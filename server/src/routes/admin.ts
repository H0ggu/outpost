import type { FastifyPluginAsync } from 'fastify';
import {
  API_ROUTES,
  type AdminSettings,
  type AdminStatus,
  type AdminUser,
  type AdminUsersResponse,
  type Invite,
  type InvitesResponse,
  type OkResponse,
} from '@outpost/shared/api';
import { z } from 'zod';
import {
  applySettingsPatch,
  createInvite,
  createInviteSchema,
  deleteInvite,
  deleteUser,
  inviteCodeParams,
  listAdminUsers,
  listInvites,
  toAdminSettings,
  updateSettingsSchema,
  updateUser,
  updateUserSchema,
  userIdParams,
} from '../auth/admin.ts';
import { hashPassword } from '../auth/password.ts';
import { requireAdmin } from '../auth/session.ts';
import { createStatusService } from '../auth/status.ts';
import { parseBody, parseParams, parseQuery } from '../http/validate.ts';

/**
 * Admin routes — PLAN §6 "Session, account and admin" (admin settings, users, invites, status), §3 (env wins over UI settings), §10.
 *
 * Endpoints (request/response types in @outpost/shared/api), all `{ preHandler: requireAdmin }`:
 *   - GET/PUT /api/admin/settings (AdminSettings / UpdateAdminSettingsRequest → AdminSettings), written
 *     through src/settings.ts. The Lichess token is write-only (shown masked, `fromEnv` when
 *     LICHESS_TOKEN wins); `null` or "" clears the UI-set lichessToken / chesscomContact.
 *     `mastersSource: 'reference:<id>'` must name a reference database.
 *   - GET /api/admin/users (AdminUsersResponse)
 *   - PATCH /api/admin/users/:id (UpdateAdminUserRequest → AdminUser): role, disabled, password reset,
 *     TOTP reset. Never demotes or disables the last active admin (409 `conflict`,
 *     `details.reason: 'last_admin'`); an admin cannot disable themself (403). Disabling or a password
 *     reset signs the user out everywhere.
 *   - DELETE /api/admin/users/:id (OkResponse): same guards (and never yourself). What happens to the
 *     user's profiles, databases and files is documented in src/auth/admin.ts.
 *   - GET/POST /api/admin/invites (InvitesResponse / CreateInviteRequest → Invite)
 *   - DELETE /api/admin/invites/:code (OkResponse; 404 when unknown)
 *   - GET /api/admin/status (AdminStatus; `?refresh=1` re-runs the cached token check and probes,
 *     which go through app.upstream — src/auth/status.ts)
 *
 * Job admin endpoints live in routes/jobs.ts, reference admin endpoints in routes/reference.ts.
 */
const statusQuery = z.object({ refresh: z.enum(['0', '1', 'true', 'false']).optional() });

const adminRoutes: FastifyPluginAsync = async app => {
  const { db, config } = app;
  const status = createStatusService({ db, config, upstream: app.upstream });
  const pre = { preHandler: requireAdmin };

  app.get(API_ROUTES.admin.settings, pre, async (): Promise<AdminSettings> => toAdminSettings(db, config));

  app.put(API_ROUTES.admin.settings, pre, async (req): Promise<AdminSettings> => {
    const patch = parseBody(updateSettingsSchema, req.body ?? {});
    applySettingsPatch(db, patch);
    if (patch.lichessToken !== undefined || patch.chesscomContact !== undefined) status.invalidate();
    req.log.info({ keys: Object.keys(patch) }, 'admin settings updated');
    return toAdminSettings(db, config);
  });

  app.get(API_ROUTES.admin.users, pre, async (): Promise<AdminUsersResponse> => ({ users: listAdminUsers(db) }));

  app.patch(API_ROUTES.admin.user(':id'), pre, async (req): Promise<AdminUser> => {
    const { id } = parseParams(userIdParams, req.params);
    const body = parseBody(updateUserSchema, req.body ?? {});
    const passwordHash = body.password === undefined ? undefined : await hashPassword(body.password);
    const user = updateUser(db, req.user!.id, id, {
      ...(body.role !== undefined ? { role: body.role } : {}),
      ...(body.disabled !== undefined ? { disabled: body.disabled } : {}),
      ...(passwordHash !== undefined ? { passwordHash } : {}),
      ...(body.resetTotp !== undefined ? { resetTotp: body.resetTotp } : {}),
    });
    req.log.info(
      { targetUserId: id, changes: Object.keys(body).filter(k => k !== 'password').concat(body.password ? ['password'] : []) },
      'admin updated user',
    );
    return user;
  });

  app.delete(API_ROUTES.admin.user(':id'), pre, async (req): Promise<OkResponse> => {
    const { id } = parseParams(userIdParams, req.params);
    deleteUser(db, req.user!.id, id);
    req.log.info({ targetUserId: id }, 'admin deleted user');
    return { ok: true };
  });

  app.get(API_ROUTES.admin.invites, pre, async (): Promise<InvitesResponse> => ({ invites: listInvites(db) }));

  app.post(API_ROUTES.admin.invites, pre, async (req): Promise<Invite> => {
    const body = parseBody(createInviteSchema, req.body ?? {});
    return createInvite(db, req.user!.id, body.expiresInDays);
  });

  app.delete(API_ROUTES.admin.invite(':code'), pre, async (req): Promise<OkResponse> => {
    const { code } = parseParams(inviteCodeParams, req.params);
    deleteInvite(db, code);
    return { ok: true };
  });

  app.get(API_ROUTES.admin.status, pre, async (req): Promise<AdminStatus> => {
    const q = parseQuery(statusQuery, req.query);
    return status.get({ refresh: q.refresh === '1' || q.refresh === 'true' });
  });
};

export default adminRoutes;
