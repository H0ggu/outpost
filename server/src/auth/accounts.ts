/**
 * User accounts: lookups, creation, validation schemas and invite consumption (PLAN §6, §10).
 * Routes stay thin and call into this module; passwords are hashed by `password.ts` before any
 * transaction starts (scrypt is async and must not run inside `db.tx`).
 */
import {
  ACCOUNT_USERNAME_RE,
  BOARD_THEMES,
  PIECE_SETS,
  SOUND_SETS,
  STUDIO_LAYOUTS,
  type Id,
  type SessionUser,
  type UserPrefs,
  type UserRole,
} from '@outpost/shared/api';
import { z } from 'zod';
import type { Db } from '../db/index.ts';
import { conflict, HttpError } from '../http/errors.ts';
import { anyPasswordSchema, passwordSchema } from './password.ts';
import { parsePrefs } from './session.ts';

/** A username for a new account (setup, signup). */
export const usernameSchema = z
  .string()
  .trim()
  .regex(ACCOUNT_USERNAME_RE, 'Username must be 2–30 letters, digits, _ or -, starting with a letter or digit');

/** `POST /api/setup`. */
export const setupSchema = z.object({
  token: z.string().trim().min(1, 'Setup token required').max(512),
  username: usernameSchema,
  password: passwordSchema,
});

/** `POST /api/login`: loose on purpose (any stored username may sign in; errors stay generic). */
export const loginSchema = z.object({
  username: z.string().trim().min(1, 'Username required').max(64),
  password: anyPasswordSchema.min(1, 'Password required'),
  totp: z.string().max(32).optional(),
});

/** `POST /api/signup`. */
export const signupSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  invite: z.string().trim().max(128).optional(),
});

/** `POST /api/me/password`. */
export const changePasswordSchema = z.object({
  currentPassword: anyPasswordSchema.min(1, 'Current password required'),
  newPassword: passwordSchema,
});

/** `PUT /api/me/prefs`: any subset of `UserPrefs`; unknown keys are refused. */
export const prefsPatchSchema = z.strictObject({
  theme: z.enum(['dark', 'black', 'light']).optional(),
  boardTheme: z.enum(BOARD_THEMES).optional(),
  pieceSet: z.enum(PIECE_SETS).optional(),
  soundSet: z.enum(SOUND_SETS).optional(),
  winratePerspective: z.enum(['player', 'white']).optional(),
  timezone: z.enum(['local', 'utc']).optional(),
  studioLayout: z.enum(STUDIO_LAYOUTS).optional(),
});

/** `POST /api/me/totp/enable`. */
export const totpEnableSchema = z.object({ code: z.string().max(32) });

/** `POST /api/me/totp/disable`: password or code (empty strings count as absent). */
export const totpDisableSchema = z
  .object({
    password: anyPasswordSchema.optional(),
    code: z.string().max(32).optional(),
  })
  .transform(v => ({ password: v.password || null, code: v.code?.trim() || null }))
  .refine(v => v.password !== null || v.code !== null, 'Enter your password or a current code');

/** Row used by login and re-authentication. */
export interface AuthRow {
  id: Id;
  username: string;
  password_hash: string;
  role: UserRole;
  disabled: number;
  totp_secret: string | null;
  totp_last_step: number | null;
  prefs_json: string;
}

const AUTH_COLUMNS = 'id, username, password_hash, role, disabled, totp_secret, totp_last_step, prefs_json';

/** Finds a user by username (case-insensitive). */
export const findUserByUsername = (db: Db, username: string): AuthRow | undefined =>
  db.get<AuthRow>(`SELECT ${AUTH_COLUMNS} FROM users WHERE username = ?`, [username.trim()]);

/** Finds a user by id. */
export const findUserById = (db: Db, id: Id): AuthRow | undefined =>
  db.get<AuthRow>(`SELECT ${AUTH_COLUMNS} FROM users WHERE id = ?`, [id]);

/** `SessionUser` for an auth row. */
export const toSessionUser = (row: Pick<AuthRow, 'id' | 'username' | 'role' | 'totp_secret' | 'prefs_json'>): SessionUser => ({
  id: row.id,
  username: row.username,
  role: row.role,
  totpEnabled: row.totp_secret !== null,
  prefs: parsePrefs(row.prefs_json),
});

/** True once any admin row exists (disabled or not): setup is then closed for good. */
export const hasAdmin = (db: Db): boolean => db.get("SELECT 1 AS x FROM users WHERE role = 'admin' LIMIT 1") !== undefined;

/** Number of admins that can sign in (role admin, not disabled). */
export const activeAdminCount = (db: Db): number =>
  db.value<number>("SELECT COUNT(*) FROM users WHERE role = 'admin' AND disabled = 0") ?? 0;

/** 409 when the username is taken (case-insensitively). */
export function assertUsernameFree(db: Db, username: string): void {
  if (db.get('SELECT 1 AS x FROM users WHERE username = ?', [username])) {
    throw conflict('That username is already taken', { field: 'username' });
  }
}

/** Inserts a user (call inside `db.tx` together with the uniqueness check). Returns the new id. */
export function insertUser(db: Db, u: { username: string; passwordHash: string; role: UserRole; now?: number }): Id {
  assertUsernameFree(db, u.username);
  const now = u.now ?? Date.now();
  try {
    return db.run('INSERT INTO users (username, password_hash, role, created_at, password_changed_at) VALUES (?, ?, ?, ?, ?)', [
      u.username,
      u.passwordHash,
      u.role,
      now,
      now,
    ]).lastInsertRowid;
  } catch (e) {
    // Another connection won the race between the check and the insert.
    if (e instanceof Error && e.message.includes('UNIQUE constraint failed: users.username')) {
      throw conflict('That username is already taken', { field: 'username' });
    }
    throw e;
  }
}

/** Replaces a user's password hash. */
export function setPasswordHash(db: Db, userId: Id, hash: string, now: number = Date.now()): void {
  db.run('UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?', [hash, now, userId]);
}

/** Merges a prefs patch into the stored prefs and returns the full result. */
export function updatePrefs(db: Db, userId: Id, patch: Partial<UserPrefs>): UserPrefs {
  return db.tx(() => {
    const current = parsePrefs(db.value<string>('SELECT prefs_json FROM users WHERE id = ?', [userId]));
    const next: UserPrefs = { ...current };
    for (const [k, v] of Object.entries(patch) as Array<[keyof UserPrefs, UserPrefs[keyof UserPrefs] | undefined]>) {
      if (v !== undefined) (next as unknown as Record<string, unknown>)[k] = v;
    }
    db.run('UPDATE users SET prefs_json = ? WHERE id = ?', [JSON.stringify(next), userId]);
    return next;
  });
}

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

/** Whether an invite code exists, is unused and has not expired (a cheap pre-check; `consumeInvite` decides). */
export function isInviteUsable(db: Db, code: string, now: number = Date.now()): boolean {
  return (
    db.get('SELECT 1 AS x FROM invites WHERE code = ? AND used_at IS NULL AND (expires_at IS NULL OR expires_at > ?)', [code, now]) !==
    undefined
  );
}

/**
 * Marks an invite used by `userId`, atomically: only an unused, unexpired code changes, so two
 * signups racing for one code cannot both succeed. Call inside the transaction that inserted the
 * user; throws 403 (rolling the user back) when the code is not usable.
 */
export function consumeInvite(db: Db, code: string, userId: Id, now: number = Date.now()): void {
  const r = db.run(
    'UPDATE invites SET used_by = ?, used_at = ? WHERE code = ? AND used_at IS NULL AND (expires_at IS NULL OR expires_at > ?)',
    [userId, now, code, now],
  );
  if (r.changes !== 1) throw invalidInvite();
}

/** 403 for an unknown, used or expired invite code. */
export const invalidInvite = (): HttpError =>
  new HttpError(403, 'forbidden', 'That invite code is invalid, already used or expired', { reason: 'invite_invalid' });

/**
 * Records a TOTP step as used, atomically (only if newer than the stored one). Returns false when a
 * concurrent request already used this step or a later one (replay).
 */
export function recordTotpStep(db: Db, userId: Id, step: number): boolean {
  return (
    db.run('UPDATE users SET totp_last_step = ? WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)', [step, userId, step])
      .changes === 1
  );
}
