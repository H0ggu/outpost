/**
 * Session lookup and access-control preHandlers (PLAN §6 "Auth and CSRF", §10).
 *
 * The signatures here are final — routes use them as `{ preHandler: requireUser }`.
 * TODO(auth): sliding expiry (extend `expires_at`, update `last_seen_at` at most once a minute),
 * session creation on login/setup/signup, logout, and `/api/me/sessions` live in the auth module;
 * this file only resolves an existing session cookie.
 */
import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { CookieSerializeOptions } from '@fastify/cookie';
import {
  BOARD_THEMES,
  DEFAULT_PREFS,
  PIECE_SETS,
  SESSION_COOKIE,
  SOUND_SETS,
  STUDIO_LAYOUTS,
  type UserPrefs,
  type UserRole,
} from '@outpost/shared/api';
import type { Config } from '../config.ts';
import { forbidden, unauthorized } from '../http/errors.ts';
import type { AuthUser } from '../http/types.ts';
import { readSettings } from '../settings.ts';

export { SESSION_COOKIE };

/** Sessions last 30 days, extended on use (sliding). */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Hex SHA-256 of a session token: the `sessions.id_hash` key. */
export const hashSessionToken = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

/** Cookie options for the session cookie (HttpOnly, SameSite=Lax, Secure on https origins). */
export const sessionCookieOptions = (config: Config): CookieSerializeOptions => ({
  path: '/',
  httpOnly: true,
  sameSite: 'lax',
  secure: config.secureCookies,
  maxAge: Math.floor(SESSION_TTL_MS / 1000),
});

const pick = <T extends string>(allowed: readonly T[], v: unknown, fallback: T): T =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;

/** `users.prefs_json` → complete `UserPrefs` (unknown or invalid fields fall back to defaults). */
export function parsePrefs(json: string | null | undefined): UserPrefs {
  let raw: Record<string, unknown> = {};
  try {
    const v: unknown = json ? JSON.parse(json) : {};
    if (v && typeof v === 'object' && !Array.isArray(v)) raw = v as Record<string, unknown>;
  } catch {
    // keep defaults
  }
  return {
    theme: pick(['dark', 'black', 'light'], raw.theme, DEFAULT_PREFS.theme),
    boardTheme: pick(BOARD_THEMES, raw.boardTheme, DEFAULT_PREFS.boardTheme),
    pieceSet: pick(PIECE_SETS, raw.pieceSet, DEFAULT_PREFS.pieceSet),
    soundSet: pick(SOUND_SETS, raw.soundSet, DEFAULT_PREFS.soundSet),
    winratePerspective: pick(['player', 'white'], raw.winratePerspective, DEFAULT_PREFS.winratePerspective),
    timezone: pick(['local', 'utc'], raw.timezone, DEFAULT_PREFS.timezone),
    studioLayout: pick(STUDIO_LAYOUTS, raw.studioLayout, DEFAULT_PREFS.studioLayout),
  };
}

interface SessionUserRow {
  id: number;
  username: string;
  role: UserRole;
  totp_secret: string | null;
  prefs_json: string;
}

const resolved = new WeakSet<FastifyRequest>();

/**
 * Resolves the session cookie once per request and caches the result on `req.user` /
 * `req.sessionHash`. Expired sessions and disabled users count as anonymous.
 */
export function loadSessionUser(req: FastifyRequest): AuthUser | null {
  if (resolved.has(req)) return req.user;
  resolved.add(req);
  req.user = null;
  req.sessionHash = null;

  const token = req.cookies[SESSION_COOKIE];
  if (!token || token.length > 256) return null;
  const hash = hashSessionToken(token);
  const row = req.server.db.get<SessionUserRow>(
    `SELECT u.id, u.username, u.role, u.totp_secret, u.prefs_json
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id_hash = ? AND s.expires_at > ? AND u.disabled = 0`,
    [hash, Date.now()],
  );
  if (!row) return null;
  req.user = {
    id: row.id,
    username: row.username,
    role: row.role,
    totpEnabled: row.totp_secret !== null,
    prefs: parsePrefs(row.prefs_json),
  };
  req.sessionHash = hash;
  return req.user;
}

/** Resolves the session if any; never rejects. */
export async function optionalUser(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  loadSessionUser(req);
}

/** 401 unless signed in. */
export async function requireUser(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!loadSessionUser(req)) throw unauthorized();
}

/** 401 unless signed in, 403 unless admin. */
export async function requireAdmin(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const user = loadSessionUser(req);
  if (!user) throw unauthorized();
  if (user.role !== 'admin') throw forbidden('Admins only');
}

/**
 * For read endpoints of public data (public profiles and their stats, PLAN §10): signed-in users
 * pass; anonymous visitors pass only when `anonymousBrowsing` is on. Per-object visibility
 * (private profiles) is still checked by the route.
 */
export async function requireViewer(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (loadSessionUser(req)) return;
  if (!readSettings(req.server.db, req.server.config).anonymousBrowsing) throw unauthorized();
}
