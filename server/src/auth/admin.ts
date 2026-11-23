/**
 * Admin operations behind routes/admin.ts (PLAN §6 admin, §3 env-over-UI settings, §10).
 *
 * Users
 * - The last **active** admin (role admin, not disabled) can never be demoted, disabled or deleted,
 *   and an admin can neither disable nor delete their own account (another admin must). Checks and
 *   writes run in one `BEGIN IMMEDIATE` transaction, so two concurrent requests cannot both pass.
 * - Disabling a user, resetting their password or deleting them signs them out everywhere.
 * - Password and TOTP resets are for *other* users. Admins change their own password with
 *   `POST /api/me/password` and turn off their own TOTP with `POST /api/me/totp/disable`, which need
 *   proof (current password / code), so a stolen admin session cannot take the account over.
 *
 * What deleting a user does (consistent with the foreign keys in 001_init.sql):
 * - At once (`beginUserDeletion`, one transaction): the user is marked `deleting_at` (hidden from the
 *   admin list, 404 for PATCH), disabled and signed out everywhere; their known devices go; the
 *   **reference** databases they own become system-owned (`owner_user_id` NULL, like the ones
 *   imported by the server), because the masters/reference explorer of every user depends on them;
 *   their personal games databases become private; their **unused** invites are deleted (an invite
 *   handed out by a removed admin must not stay valid); their profiles (with source links, bookmarks
 *   by others and prep-list entries), Studio files (incl. the recycle bin) and prep sets are deleted.
 * - Then in the background (src/auth/purge.ts, small batches): their personal **games** databases
 *   with those games, positions and pgn sources; finally the user row, whose remaining rows cascade
 *   (bookmarks, recently-viewed) or are SET NULL.
 * - Kept: Lichess / Chess.com / FIDE `sources` and their games are shared sync identities and stay.
 *   Used invites keep their history with the user reference cleared (SET NULL; a used invite stays
 *   used). Jobs they queued stay with `user_id` NULL (jobs whose database is gone fail harmlessly in
 *   the worker).
 */
import { randomBytes } from 'node:crypto';
import {
  API_ROUTES,
  type AdminSettings,
  type AdminUser,
  type Id,
  type Invite,
  type MaskedSecret,
  type UserRole,
} from '@outpost/shared/api';
import { z } from 'zod';
import type { Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import { conflict, forbidden, HttpError, notFound, validationError } from '../http/errors.ts';
import { readSettings, writeSettings, type InstanceSettings } from '../settings.ts';
import { activeAdminCount } from './accounts.ts';
import { passwordSchema } from './password.ts';
import { revokeUserSessions } from './session.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** `lip_…a1b2`: enough to recognise a token, never enough to use it. */
export function maskSecret(secret: string): string {
  if (secret.length < 12) return '…';
  const prefix = /^[a-z]{2,5}_/.exec(secret)?.[0] ?? secret.slice(0, 2);
  return `${prefix}…${secret.slice(-4)}`;
}

/** Effective settings as the admin sees them (the Lichess token masked, env overrides flagged). */
export function toAdminSettings(db: Db, config: Config): AdminSettings {
  const s = readSettings(db, config);
  const token: MaskedSecret = {
    set: s.lichessToken !== null,
    masked: s.lichessToken === null ? null : maskSecret(s.lichessToken),
    fromEnv: config.lichessToken !== null,
  };
  return {
    signupMode: s.signupMode,
    anonymousBrowsing: s.anonymousBrowsing,
    lichessToken: token,
    chesscomContact: s.chesscomContact,
    chesscomContactFromEnv: config.chesscomContact !== null,
    autoRefreshHourUtc: s.autoRefreshHourUtc,
    updateCooldownMinutes: s.updateCooldownMinutes,
    initialSyncMonths: s.initialSyncMonths,
    mastersSource: s.mastersSource,
    broadcastAutoImport: s.broadcastAutoImport,
  };
}

/** Blank strings mean "clear" for the nullable secrets. */
const nullableText = (inner: z.ZodString) =>
  z
    .union([z.string(), z.null()])
    .transform(v => (v === null || v.trim() === '' ? null : v.trim()))
    .pipe(z.union([inner, z.null()]));

/** `PUT /api/admin/settings` body. Unknown keys are refused. */
export const updateSettingsSchema = z.strictObject({
  signupMode: z.enum(['closed', 'invite', 'open']).optional(),
  anonymousBrowsing: z.boolean().optional(),
  lichessToken: nullableText(
    z.string().max(2048).regex(/^[A-Za-z0-9_]+$/, 'A Lichess token only contains letters, digits and _'),
  ).optional(),
  chesscomContact: nullableText(
    // It goes into the User-Agent header: printable ASCII only (no CR/LF, no header injection).
    z.string().max(200).regex(/^[\x20-\x7e]+$/, 'Use plain ASCII text (e.g. an email address or a Chess.com username)'),
  ).optional(),
  autoRefreshHourUtc: z.number().int().min(0).max(23).optional(),
  updateCooldownMinutes: z.number().int().min(0).max(7 * 24 * 60).optional(),
  initialSyncMonths: z.number().int().min(0).max(600).optional(),
  mastersSource: z
    .string()
    .regex(/^(lichess|reference:[1-9]\d{0,15})$/, "Use 'lichess' or 'reference:<database id>'")
    .optional(),
  broadcastAutoImport: z.boolean().optional(),
});

/** Applies a validated settings patch. Throws 400 when `mastersSource` names no reference database. */
export function applySettingsPatch(db: Db, patch: z.output<typeof updateSettingsSchema>): void {
  const out: Partial<InstanceSettings> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  if (patch.mastersSource?.startsWith('reference:')) {
    const id = Number(patch.mastersSource.slice('reference:'.length));
    if (!db.get("SELECT 1 AS x FROM databases WHERE id = ? AND kind = 'reference'", [id])) {
      throw validationError(`mastersSource: no reference database with id ${id}`, {
        issues: [{ path: 'mastersSource', message: 'No such reference database' }],
      });
    }
  }
  writeSettings(db, out);
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

interface AdminUserRow {
  id: Id;
  username: string;
  role: UserRole;
  disabled: number;
  totp: number;
  created_at: number;
  last_seen_at: number | null;
  profile_count: number;
}

/**
 * Users not being deleted. `last_seen_at`: the stored last activity (it survives logout and
 * revocation), or a newer live session's if any.
 */
const ADMIN_USER_SELECT = `
  SELECT u.id, u.username, u.role, u.disabled, u.totp_secret IS NOT NULL AS totp, u.created_at,
         NULLIF(MAX(COALESCE(u.last_seen_at, 0),
                    COALESCE((SELECT MAX(s.last_seen_at) FROM sessions s WHERE s.user_id = u.id), 0)), 0) AS last_seen_at,
         (SELECT COUNT(*) FROM profiles p WHERE p.owner_user_id = u.id) AS profile_count
    FROM users u
   WHERE u.deleting_at IS NULL`;

const toAdminUser = (r: AdminUserRow): AdminUser => ({
  id: r.id,
  username: r.username,
  role: r.role,
  disabled: r.disabled === 1,
  totpEnabled: r.totp === 1,
  createdAt: r.created_at,
  lastSeenAt: r.last_seen_at,
  profileCount: r.profile_count,
});

/** Every user, admins first, then by name. */
export const listAdminUsers = (db: Db): AdminUser[] =>
  db
    .all<AdminUserRow>(`${ADMIN_USER_SELECT} ORDER BY u.role = 'admin' DESC, u.username COLLATE NOCASE`)
    .map(toAdminUser);

/** One user, or null. */
export const getAdminUser = (db: Db, id: Id): AdminUser | null => {
  const r = db.get<AdminUserRow>(`${ADMIN_USER_SELECT} AND u.id = ?`, [id]);
  return r ? toAdminUser(r) : null;
};

/** `PATCH /api/admin/users/:id` body. */
export const updateUserSchema = z.strictObject({
  role: z.enum(['admin', 'user']).optional(),
  disabled: z.boolean().optional(),
  password: passwordSchema.optional(),
  resetTotp: z.boolean().optional(),
});

/** `{ id }` path params with a positive integer id. */
export const userIdParams = z.object({ id: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER) });

const LAST_ADMIN = 'Outpost needs at least one active admin: promote or re-enable another admin first';

/**
 * 403 for an admin resetting their own password or TOTP through the admin API: that needs the
 * self-service endpoints, which ask for proof.
 */
export function assertNotSelfReset(actorId: Id, targetId: Id, patch: { password?: unknown; passwordHash?: unknown; resetTotp?: boolean }): void {
  if (targetId !== actorId) return;
  if (patch.password !== undefined || patch.passwordHash !== undefined) {
    throw new HttpError(403, 'forbidden', `Change your own password under your account settings (POST ${API_ROUTES.me.password}), which asks for the current one`, {
      reason: 'self_reset',
    });
  }
  if (patch.resetTotp === true) {
    throw new HttpError(403, 'forbidden', `Turn off your own two-factor authentication under your account settings (POST ${API_ROUTES.me.totpDisable})`, {
      reason: 'self_reset',
    });
  }
}

/** Applies an admin's change to another user or themself (the new password, if any, already hashed). Returns the updated user. */
export function updateUser(
  db: Db,
  actorId: Id,
  targetId: Id,
  patch: { role?: UserRole; disabled?: boolean; passwordHash?: string; resetTotp?: boolean },
): AdminUser {
  return db.tx(() => {
    const target = db.get<{ id: Id; role: UserRole; disabled: number }>(
      'SELECT id, role, disabled FROM users WHERE id = ? AND deleting_at IS NULL',
      [targetId],
    );
    if (!target) throw notFound('No such user');
    if (patch.disabled === true && targetId === actorId) throw forbidden('You cannot disable your own account');
    assertNotSelfReset(actorId, targetId, patch);

    const activeAdminNow = target.role === 'admin' && target.disabled === 0;
    const losesAdmin = (patch.role !== undefined && patch.role !== 'admin') || patch.disabled === true;
    if (activeAdminNow && losesAdmin && activeAdminCount(db) <= 1) throw conflict(LAST_ADMIN, { reason: 'last_admin' });

    const now = Date.now();
    if (patch.role !== undefined) db.run('UPDATE users SET role = ? WHERE id = ?', [patch.role, targetId]);
    if (patch.disabled !== undefined) db.run('UPDATE users SET disabled = ? WHERE id = ?', [patch.disabled, targetId]);
    if (patch.passwordHash !== undefined) {
      db.run('UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?', [patch.passwordHash, now, targetId]);
    }
    if (patch.resetTotp) {
      db.run(
        'UPDATE users SET totp_secret = NULL, totp_last_step = NULL, totp_pending_secret = NULL, totp_pending_at = NULL WHERE id = ?',
        [targetId],
      );
    }
    if (patch.disabled === true || patch.passwordHash !== undefined) revokeUserSessions(db, targetId);
    return getAdminUser(db, targetId)!;
  });
}

/**
 * First, synchronous part of deleting a user (see the module comment); the background purge
 * (src/auth/purge.ts) does the rest. Idempotent for a user already being deleted, so a purge that
 * gave up can be restarted by deleting again.
 */
export function beginUserDeletion(db: Db, actorId: Id, targetId: Id, now: number = Date.now()): void {
  db.tx(() => {
    const target = db.get<{ role: UserRole; disabled: number; deleting_at: number | null }>(
      'SELECT role, disabled, deleting_at FROM users WHERE id = ?',
      [targetId],
    );
    if (!target) throw notFound('No such user');
    if (targetId === actorId) throw forbidden('You cannot delete your own account; ask another admin');
    if (target.deleting_at !== null) return;
    if (target.role === 'admin' && target.disabled === 0 && activeAdminCount(db) <= 1) {
      throw conflict(LAST_ADMIN, { reason: 'last_admin' });
    }
    db.run('UPDATE users SET deleting_at = ?, disabled = 1, totp_pending_secret = NULL, totp_pending_at = NULL WHERE id = ?', [now, targetId]);
    revokeUserSessions(db, targetId);
    db.run('DELETE FROM known_devices WHERE user_id = ?', [targetId]);
    db.run("UPDATE databases SET owner_user_id = NULL WHERE owner_user_id = ? AND kind = 'reference'", [targetId]);
    db.run("UPDATE databases SET visibility = 'private' WHERE owner_user_id = ? AND kind = 'games'", [targetId]);
    db.run('DELETE FROM invites WHERE created_by = ? AND used_at IS NULL', [targetId]);
    db.run('DELETE FROM profiles WHERE owner_user_id = ?', [targetId]);
    db.run('DELETE FROM files WHERE owner_user_id = ?', [targetId]);
    db.run('DELETE FROM prep_sets WHERE owner_user_id = ?', [targetId]);
  });
}

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

/** `POST /api/admin/invites` body. */
export const createInviteSchema = z.strictObject({
  expiresInDays: z.number().int().min(1).max(365).optional(),
});

/** `{ code }` path params. */
export const inviteCodeParams = z.object({ code: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, 'invalid invite code') });

interface InviteRow {
  code: string;
  created_by: Id | null;
  created_by_name: string | null;
  created_at: number;
  expires_at: number | null;
  used_by: Id | null;
  used_by_name: string | null;
  used_at: number | null;
}

const INVITE_SELECT = `
  SELECT i.code, i.created_by, cu.username AS created_by_name, i.created_at, i.expires_at,
         i.used_by, uu.username AS used_by_name, i.used_at
    FROM invites i
    LEFT JOIN users cu ON cu.id = i.created_by
    LEFT JOIN users uu ON uu.id = i.used_by`;

const toInvite = (r: InviteRow): Invite => ({
  code: r.code,
  createdBy: r.created_by !== null && r.created_by_name !== null ? { id: r.created_by, username: r.created_by_name } : null,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  usedBy: r.used_by !== null && r.used_by_name !== null ? { id: r.used_by, username: r.used_by_name } : null,
  usedAt: r.used_at,
});

/** Every invite, newest first. */
export const listInvites = (db: Db): Invite[] => db.all<InviteRow>(`${INVITE_SELECT} ORDER BY i.created_at DESC, i.code`).map(toInvite);

/** Creates an invite code (128 random bits, URL-safe). */
export function createInvite(db: Db, createdBy: Id, expiresInDays: number | undefined, now: number = Date.now()): Invite {
  const code = randomBytes(16).toString('base64url');
  const expiresAt = expiresInDays === undefined ? null : now + expiresInDays * DAY_MS;
  db.run('INSERT INTO invites (code, created_by, created_at, expires_at) VALUES (?, ?, ?, ?)', [code, createdBy, now, expiresAt]);
  return toInvite(db.get<InviteRow>(`${INVITE_SELECT} WHERE i.code = ?`, [code])!);
}

/** Deletes an invite. 404 when unknown. */
export function deleteInvite(db: Db, code: string): void {
  if (db.run('DELETE FROM invites WHERE code = ?', [code]).changes === 0) throw notFound('No such invite');
}
