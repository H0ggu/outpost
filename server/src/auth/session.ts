/**
 * Sessions and access-control preHandlers (PLAN §6 "Auth and CSRF", §10).
 *
 * - The cookie `outpost_session` holds 32 random bytes (base64url). Only the hex SHA-256 of it is
 *   stored (`sessions.id_hash`), so a database leak does not leak usable sessions.
 * - Sessions last 30 days and slide: a request with a live session moves `expires_at` to now + 30 days
 *   and records `last_seen_at` / IP / user agent, at most once per `SESSION_TOUCH_INTERVAL_MS` per
 *   session (so ordinary browsing does not write on every request). The preHandlers below then
 *   re-send the cookie so the browser's expiry slides too.
 * - Expired sessions are ignored on lookup and deleted by `purgeExpiredSessions` (run hourly by the
 *   auth plugin).
 *
 * The preHandler signatures are final — routes use them as `{ preHandler: requireUser }`.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { CookieSerializeOptions } from '@fastify/cookie';
import {
  BOARD_THEMES,
  DEFAULT_PREFS,
  PIECE_SETS,
  SESSION_COOKIE,
  SOUND_SETS,
  STUDIO_LAYOUTS,
  type EpochMs,
  type Id,
  type SessionRow,
  type UserPrefs,
  type UserRole,
} from '@outpost/shared/api';
import type { Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import { forbidden, unauthorized } from '../http/errors.ts';
import type { AuthUser } from '../http/types.ts';
import { readSettings } from '../settings.ts';

export { SESSION_COOKIE };

/** Sessions last 30 days, extended on use (sliding). */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** A session's `last_seen_at` / `expires_at` are written at most this often. */
export const SESSION_TOUCH_INTERVAL_MS = 60_000;
/** Random bytes in a session token. */
export const SESSION_TOKEN_BYTES = 32;
/** Longest user agent kept with a session. */
const MAX_USER_AGENT = 512;
/** Longest cookie value considered at all (a real token is 43 characters). */
const MAX_TOKEN_LENGTH = 256;

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
  last_seen_at: number;
}

const resolved = new WeakSet<FastifyRequest>();
/** Requests whose session was just extended: the preHandlers re-send the cookie. */
const touched = new WeakSet<FastifyRequest>();

/** Client metadata stored with a session. */
export interface SessionMeta {
  ip: string | null;
  userAgent: string | null;
}

/** IP and user agent of a request, as stored with its session. */
export const sessionMeta = (req: FastifyRequest): SessionMeta => {
  const ua = req.headers['user-agent'];
  return {
    ip: req.ip || null,
    userAgent: typeof ua === 'string' && ua ? ua.slice(0, MAX_USER_AGENT) : null,
  };
};

/**
 * Resolves the session cookie once per request and caches the result on `req.user` /
 * `req.sessionHash`. Expired sessions and disabled users count as anonymous. A live session is
 * extended (sliding expiry) at most once per `SESSION_TOUCH_INTERVAL_MS`.
 */
export function loadSessionUser(req: FastifyRequest): AuthUser | null {
  if (resolved.has(req)) return req.user;
  resolved.add(req);
  req.user = null;
  req.sessionHash = null;

  const token = req.cookies[SESSION_COOKIE];
  if (!token || token.length > MAX_TOKEN_LENGTH) return null;
  const hash = hashSessionToken(token);
  const db = req.server.db;
  const now = Date.now();
  const row = db.get<SessionUserRow>(
    `SELECT u.id, u.username, u.role, u.totp_secret, u.prefs_json, s.last_seen_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id_hash = ? AND s.expires_at > ? AND u.disabled = 0`,
    [hash, now],
  );
  if (!row) return null;
  if (now - row.last_seen_at >= SESSION_TOUCH_INTERVAL_MS) {
    const meta = sessionMeta(req);
    try {
      db.run('UPDATE sessions SET last_seen_at = ?, expires_at = ?, ip = ?, user_agent = COALESCE(?, user_agent) WHERE id_hash = ?', [
        now,
        now + SESSION_TTL_MS,
        meta.ip,
        meta.userAgent,
        hash,
      ]);
      touched.add(req);
    } catch (err) {
      // A busy database must not fail the request; the next one retries.
      req.log.warn({ err }, 'could not extend session');
    }
  }
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

/** Re-sends the session cookie when `loadSessionUser` just extended the session. */
function refreshCookie(req: FastifyRequest, reply: FastifyReply): void {
  if (!touched.has(req)) return;
  touched.delete(req);
  const token = req.cookies[SESSION_COOKIE];
  if (token && req.user) reply.setCookie(SESSION_COOKIE, token, sessionCookieOptions(req.server.config));
}

/** Resolves the session if any; never rejects. */
export async function optionalUser(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  loadSessionUser(req);
  refreshCookie(req, reply);
}

/** 401 unless signed in. */
export async function requireUser(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!loadSessionUser(req)) throw unauthorized();
  refreshCookie(req, reply);
}

/** 401 unless signed in, 403 unless admin. */
export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const user = loadSessionUser(req);
  if (!user) throw unauthorized();
  refreshCookie(req, reply);
  if (user.role !== 'admin') throw forbidden('Admins only');
}

/**
 * For read endpoints of public data (public profiles and their stats, PLAN §10): signed-in users
 * pass; anonymous visitors pass only when `anonymousBrowsing` is on. Per-object visibility
 * (private profiles) is still checked by the route.
 */
export async function requireViewer(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (loadSessionUser(req)) {
    refreshCookie(req, reply);
    return;
  }
  if (!readSettings(req.server.db, req.server.config).anonymousBrowsing) throw unauthorized();
}

// ---------------------------------------------------------------------------
// Session lifecycle (login, logout, revocation)
// ---------------------------------------------------------------------------

/** A freshly created session: `token` goes into the cookie, only `hash` is stored. */
export interface NewSession {
  token: string;
  hash: string;
  expiresAt: EpochMs;
}

/** Creates a session for `userId`. */
export function createSession(db: Db, userId: Id, meta: SessionMeta, now: number = Date.now()): NewSession {
  const token = randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
  const hash = hashSessionToken(token);
  const expiresAt = now + SESSION_TTL_MS;
  db.run(
    'INSERT INTO sessions (id_hash, user_id, created_at, expires_at, last_seen_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [hash, userId, now, expiresAt, now, meta.ip, meta.userAgent],
  );
  return { token, hash, expiresAt };
}

/** Sets the session cookie on `reply`. */
export function setSessionCookie(reply: FastifyReply, config: Config, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, sessionCookieOptions(config));
}

/** Expires the session cookie in the browser. */
export function clearSessionCookie(reply: FastifyReply, config: Config): void {
  const { maxAge: _maxAge, ...opts } = sessionCookieOptions(config);
  reply.clearCookie(SESSION_COOKIE, opts);
}

/**
 * Signs `req` in as `userId`: drops the session the request came with (if any), creates a new one
 * and sets the cookie. Used by setup, login and signup.
 */
export function startSession(req: FastifyRequest, reply: FastifyReply, userId: Id): NewSession {
  const db = req.server.db;
  const old = req.cookies[SESSION_COOKIE];
  if (old && old.length <= MAX_TOKEN_LENGTH) deleteSession(db, hashSessionToken(old));
  const s = createSession(db, userId, sessionMeta(req));
  setSessionCookie(reply, req.server.config, s.token);
  return s;
}

/** Deletes one session by its hash. Returns whether it existed. */
export function deleteSession(db: Db, hash: string): boolean {
  return db.run('DELETE FROM sessions WHERE id_hash = ?', [hash]).changes > 0;
}

/** Deletes every session of a user, except `except` (a hash) when given. Returns how many. */
export function revokeUserSessions(db: Db, userId: Id, opts: { except?: string | null } = {}): number {
  if (opts.except) {
    return db.run('DELETE FROM sessions WHERE user_id = ? AND id_hash <> ?', [userId, opts.except]).changes;
  }
  return db.run('DELETE FROM sessions WHERE user_id = ?', [userId]).changes;
}

/** Deletes expired sessions. Returns how many. */
export function purgeExpiredSessions(db: Db, now: number = Date.now()): number {
  return db.run('DELETE FROM sessions WHERE expires_at <= ?', [now]).changes;
}

/** A user's live sessions, most recently used first, with the current one marked. */
export function listUserSessions(db: Db, userId: Id, currentHash: string | null, now: number = Date.now()): SessionRow[] {
  return db
    .all<{ id_hash: string; created_at: number; last_seen_at: number; expires_at: number; ip: string | null; user_agent: string | null }>(
      `SELECT id_hash, created_at, last_seen_at, expires_at, ip, user_agent
         FROM sessions WHERE user_id = ? AND expires_at > ?
        ORDER BY last_seen_at DESC, created_at DESC`,
      [userId, now],
    )
    .map(r => ({
      id: r.id_hash,
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
      expiresAt: r.expires_at,
      ip: r.ip,
      userAgent: r.user_agent,
      current: r.id_hash === currentHash,
    }));
}
