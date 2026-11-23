/**
 * Known devices (PLAN §10 throttling): browsers that signed in to an account before.
 *
 * After every successful password sign-in (setup, signup, login) the browser gets the cookie
 * `outpost_device`: 32 random bytes, HttpOnly, SameSite=Strict, sent only to `POST /api/login`.
 * Only the SHA-256 of it is stored (`known_devices`, migration 101), one row per account signed in
 * from that browser: a browser keeps its token when another account signs in on it, as long as the
 * server issued that token (an unknown value is replaced, so a planted cookie gains nothing). A
 * device stays known for a year after its last sign-in; each account keeps its
 * `MAX_DEVICES_PER_USER` most recent devices.
 *
 * A known device proves nothing by itself — the password (and TOTP code) are still required — it
 * only exempts the browser from the per-account sign-in ceiling (src/auth/throttle.ts), so failed
 * attempts from other addresses cannot lock the owner out of the browsers they already use.
 */
import { randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { CookieSerializeOptions } from '@fastify/cookie';
import { API_ROUTES, type Id } from '@outpost/shared/api';
import type { Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import { hashSessionToken } from './session.ts';

/** Cookie holding the device token. */
export const DEVICE_COOKIE = 'outpost_device';
/** A device is forgotten this long after its last sign-in. */
export const DEVICE_TTL_MS = 365 * 24 * 60 * 60 * 1000;
/** Devices remembered per account (the least recently used ones are dropped). */
export const MAX_DEVICES_PER_USER = 20;
/** Longest cookie value considered (a real token is 43 characters). */
const MAX_TOKEN_LENGTH = 256;

/** Cookie options: only sent with sign-in requests. */
export const deviceCookieOptions = (config: Config): CookieSerializeOptions => ({
  path: API_ROUTES.login,
  httpOnly: true,
  sameSite: 'strict',
  secure: config.secureCookies,
  maxAge: Math.floor(DEVICE_TTL_MS / 1000),
});

const tokenOf = (req: FastifyRequest): string | null => {
  const token = req.cookies[DEVICE_COOKIE];
  return token && token.length <= MAX_TOKEN_LENGTH ? token : null;
};

/** Whether the request comes from a browser that signed in to `username` before. */
export function isKnownDevice(db: Db, req: FastifyRequest, username: string, now: number = Date.now()): boolean {
  const token = tokenOf(req);
  if (!token) return false;
  return (
    db.get(
      `SELECT 1 AS x FROM known_devices d JOIN users u ON u.id = d.user_id
        WHERE d.token_hash = ? AND u.username = ? AND d.last_used_at > ?`,
      [hashSessionToken(token), username.trim(), now - DEVICE_TTL_MS],
    ) !== undefined
  );
}

/**
 * Remembers the requesting browser as a device of `userId` after a successful sign-in. Keeps the
 * browser's token when the server issued it (for this or another account), otherwise issues one.
 */
export function rememberDevice(req: FastifyRequest, reply: FastifyReply, userId: Id, now: number = Date.now()): void {
  const db = req.server.db;
  const sent = tokenOf(req);
  try {
    const token = db.tx(() => {
      const issued = (token: string): boolean =>
        db.get('SELECT 1 AS x FROM known_devices WHERE token_hash = ? LIMIT 1', [hashSessionToken(token)]) !== undefined;
      const t = sent !== null && issued(sent) ? sent : randomBytes(32).toString('base64url');
      db.run(
        `INSERT INTO known_devices (token_hash, user_id, created_at, last_used_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (token_hash, user_id) DO UPDATE SET last_used_at = excluded.last_used_at`,
        [hashSessionToken(t), userId, now, now],
      );
      db.run(
        `DELETE FROM known_devices WHERE user_id = ? AND token_hash NOT IN (
           SELECT token_hash FROM known_devices WHERE user_id = ? ORDER BY last_used_at DESC LIMIT ?)`,
        [userId, userId, MAX_DEVICES_PER_USER],
      );
      return t;
    });
    reply.setCookie(DEVICE_COOKIE, token, deviceCookieOptions(req.server.config));
  } catch (err) {
    // Only a convenience: never fail a sign-in over it.
    req.log.warn({ err }, 'could not remember the device');
  }
}

/** Forgets devices unused for `DEVICE_TTL_MS`. Returns how many. */
export function purgeStaleDevices(db: Db, now: number = Date.now()): number {
  return db.run('DELETE FROM known_devices WHERE last_used_at <= ?', [now - DEVICE_TTL_MS]).changes;
}
