/**
 * Admin operations behind routes/admin.ts (PLAN §6 admin, §3 env-over-UI settings, §10).
 *
 * Users
 * - The last **active** admin (role admin, not disabled) can never be demoted, disabled or deleted,
 *   and an admin can neither disable nor delete their own account (another admin must). Checks and
 *   writes run in one `BEGIN IMMEDIATE` transaction, so two concurrent requests cannot both pass.
 * - Disabling a user, resetting their password or deleting them signs them out everywhere.
 *
 * What deleting a user does (consistent with the foreign keys in 001_init.sql):
 * - Removed with the user (ON DELETE CASCADE): sessions, bookmarks, recently-viewed rows, the
 *   profiles they own (with their source links and prep-list entries), their personal **games**
 *   databases (with those games, positions and pgn sources), their Studio files (incl. the recycle
 *   bin) and their prep sets.
 * - Kept: **reference** databases they own become system-owned (`owner_user_id` NULL, like the ones
 *   imported by the server) first, because the masters/reference explorer of every user depends on
 *   them. Lichess / Chess.com / FIDE `sources` and their games are shared sync identities and stay.
 *   Invites they created or used keep their history with the user reference cleared (SET NULL; a
 *   used invite stays used). Jobs they queued stay with `user_id` NULL (jobs whose database is gone
 *   fail harmlessly in the worker).
 */
import { randomBytes } from 'node:crypto';
import {
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
import { conflict, forbidden, notFound, validationError } from '../http/errors.ts';
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

const ADMIN_USER_SELECT = `
  SELECT u.id, u.username, u.role, u.disabled, u.totp_secret IS NOT NULL AS totp, u.created_at,
         (SELECT MAX(s.last_seen_at) FROM sessions s WHERE s.user_id = u.id) AS last_seen_at,
         (SELECT COUNT(*) FROM profiles p WHERE p.owner_user_id = u.id) AS profile_count
    FROM users u`;

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
  const r = db.get<AdminUserRow>(`${ADMIN_USER_SELECT} WHERE u.id = ?`, [id]);
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
 * Applies an admin's change to a user (the new password, if any, already hashed).
 * Returns the updated user. `actorSession` (the admin's own session hash) survives when admins
 * reset their own password, like `POST /api/me/password`.
 */
export function updateUser(
  db: Db,
  actorId: Id,
  targetId: Id,
  patch: { role?: UserRole; disabled?: boolean; passwordHash?: string; resetTotp?: boolean },
  actorSession: string | null = null,
): AdminUser {
  return db.tx(() => {
    const target = db.get<{ id: Id; role: UserRole; disabled: number }>('SELECT id, role, disabled FROM users WHERE id = ?', [targetId]);
    if (!target) throw notFound('No such user');
    if (patch.disabled === true && targetId === actorId) throw forbidden('You cannot disable your own account');

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
    if (patch.disabled === true || patch.passwordHash !== undefined) {
      revokeUserSessions(db, targetId, { except: targetId === actorId ? actorSession : null });
    }
    return getAdminUser(db, targetId)!;
  });
}

/** Deletes a user (see the module comment for what happens to their data). */
export function deleteUser(db: Db, actorId: Id, targetId: Id): void {
  db.tx(() => {
    const target = db.get<{ role: UserRole; disabled: number }>('SELECT role, disabled FROM users WHERE id = ?', [targetId]);
    if (!target) throw notFound('No such user');
    if (targetId === actorId) throw forbidden('You cannot delete your own account; ask another admin');
    if (target.role === 'admin' && target.disabled === 0 && activeAdminCount(db) <= 1) {
      throw conflict(LAST_ADMIN, { reason: 'last_admin' });
    }
    db.run("UPDATE databases SET owner_user_id = NULL WHERE owner_user_id = ? AND kind = 'reference'", [targetId]);
    db.run('DELETE FROM users WHERE id = ?', [targetId]);
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
