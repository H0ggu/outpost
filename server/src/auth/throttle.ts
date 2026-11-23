/**
 * Throttling for the auth endpoints (PLAN §10).
 *
 * Layers:
 * 1. **Per client** — `@fastify/rate-limit` (registered with `global: false` in app.ts), opted in per
 *    route with `config: ipRateLimit(IP_LIMITS.login)`. Counts every request to that route from one
 *    client (`clientKey(req.ip)`: the IP, which honours TRUSTED_PROXIES; IPv6 grouped by /64).
 * 2. **Per account and client on failed sign-ins** — `FailureThrottle` keyed by account + client:
 *    wrong passwords and wrong TOTP codes at login. Once a pair has `FAILURE_LIMITS.accountClient.max`
 *    failures inside the window, that client is refused for that account, even with the right
 *    password, until the oldest failure ages out. A successful login clears the pair. Somebody
 *    guessing from one address therefore only locks themself out.
 * 3. **Per account across all clients** — a much higher ceiling (`FAILURE_LIMITS.account`) against
 *    guessing spread over many addresses. It refuses even a correct password, but never for a
 *    *known device* (a browser holding the `outpost_device` cookie from an earlier sign-in to this
 *    account, src/auth/devices.ts), so a distributed attack cannot lock the owner out of the
 *    devices they already use.
 * 4. **Re-authentication** inside a session (current password for a password change or TOTP setup,
 *    TOTP codes for enable/disable) is counted per user (`FAILURE_LIMITS.reauth`), separately from
 *    sign-ins: a session cannot be used to lock the account's sign-in.
 * 5. **Invite codes** — unknown, used or expired codes per client (`FAILURE_LIMITS.invite`).
 *
 * All answer 429 `rate_limited` with `details: { retryAt, retryAfterSec }` and a `Retry-After` header.
 * State is per process (one Outpost process per instance); a restart clears it.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { normalizeIP } from '@fastify/rate-limit';
import type { EpochMs } from '@outpost/shared/api';
import { HttpError } from '../http/errors.ts';

/** A per-IP limit: at most `max` requests per `timeWindowMs`. */
export interface IpLimit {
  max: number;
  timeWindowMs: number;
}

const MIN = 60_000;

/** Per-IP request limits of the auth routes. */
export const IP_LIMITS = {
  login: { max: 10, timeWindowMs: MIN },
  signup: { max: 10, timeWindowMs: 60 * MIN },
  setup: { max: 10, timeWindowMs: 15 * MIN },
  /** TOTP setup / enable / disable. */
  totp: { max: 10, timeWindowMs: 5 * MIN },
  password: { max: 10, timeWindowMs: 15 * MIN },
} as const satisfies Record<string, IpLimit>;

/** Failure budgets of the in-memory throttles (see the module comment). */
export const FAILURE_LIMITS = {
  /** Failed sign-ins (password or TOTP code) for one account from one client. */
  accountClient: { max: 10, windowMs: 15 * MIN },
  /** Failed sign-ins for one account from all clients together; known devices are exempt. */
  account: { max: 100, windowMs: 15 * MIN },
  /** Wrong current password / TOTP code inside a session, per user. */
  reauth: { max: 10, windowMs: 15 * MIN },
  /** Unknown, used or expired invite codes, per client. */
  invite: { max: 5, windowMs: 15 * MIN },
} as const;

/**
 * Throttle key of a client address: the IP as `@fastify/rate-limit` groups it (IPv4-mapped IPv6 as
 * IPv4, other IPv6 addresses by their /64 prefix, which one host usually controls entirely).
 */
export const clientKey = (ip: string | undefined): string => {
  if (!ip) return 'ip:unknown';
  try {
    return `ip:${normalizeIP(ip)}`;
  } catch {
    return `ip:${ip.toLowerCase()}`;
  }
};

/** 429 `rate_limited` with when to retry. */
export function throttledError(retryAt: EpochMs, message = 'Too many attempts', now: number = Date.now()): HttpError {
  const retryAfterSec = Math.max(1, Math.ceil((retryAt - now) / 1000));
  return new HttpError(429, 'rate_limited', `${message}; try again in ${formatWait(retryAfterSec)}`, { retryAt, retryAfterSec });
}

const formatWait = (sec: number): string =>
  sec < 90 ? `${sec} second${sec === 1 ? '' : 's'}` : `${Math.ceil(sec / 60)} minutes`;

/**
 * Route config for `@fastify/rate-limit` (per IP), answering with the uniform error body:
 * `app.post(path, { config: ipRateLimit(IP_LIMITS.login) }, …)`.
 */
export function ipRateLimit(limit: IpLimit) {
  return {
    rateLimit: {
      max: limit.max,
      timeWindow: limit.timeWindowMs,
      keyGenerator: (req: FastifyRequest) => clientKey(req.ip),
      errorResponseBuilder: (_req: FastifyRequest, ctx: { ttl: number }) =>
        throttledError(Date.now() + ctx.ttl, 'Too many requests from your address'),
    },
  };
}

/** Sliding-window failure counter keyed by a string (see the module comment). */
export class FailureThrottle {
  readonly max: number;
  readonly windowMs: number;
  readonly #now: () => number;
  readonly #maxKeys: number;
  /** key → failure times (oldest first, at most `max`). */
  readonly #failures = new Map<string, number[]>();

  constructor(opts: { max: number; windowMs: number; now?: () => number; maxKeys?: number }) {
    this.max = opts.max;
    this.windowMs = opts.windowMs;
    this.#now = opts.now ?? Date.now;
    this.#maxKeys = opts.maxKeys ?? 50_000;
  }

  #live(key: string): number[] {
    const list = this.#failures.get(key);
    if (!list) return [];
    const cutoff = this.#now() - this.windowMs;
    while (list.length && list[0]! <= cutoff) list.shift();
    if (!list.length) this.#failures.delete(key);
    return list;
  }

  /** When `key` may try again, or null when it is not throttled. */
  blockedUntil(key: string): EpochMs | null {
    const list = this.#live(key);
    return list.length >= this.max ? list[0]! + this.windowMs : null;
  }

  /** Throws 429 when `key` is throttled. */
  assertAllowed(key: string, reply?: FastifyReply, message?: string): void {
    const until = this.blockedUntil(key);
    if (until === null) return;
    const err = throttledError(until, message, this.#now());
    reply?.header('retry-after', String((err.details as { retryAfterSec: number }).retryAfterSec));
    throw err;
  }

  /** Records one failure for `key`. */
  fail(key: string): void {
    const list = this.#live(key);
    list.push(this.#now());
    if (list.length > this.max) list.splice(0, list.length - this.max);
    // Re-insert so Map order tracks recency, then cap the number of keys (oldest first).
    this.#failures.delete(key);
    this.#failures.set(key, list);
    if (this.#failures.size > this.#maxKeys) {
      const oldest = this.#failures.keys().next().value;
      if (oldest !== undefined) this.#failures.delete(oldest);
    }
  }

  /** Clears `key` (after a successful login). */
  reset(key: string): void {
    this.#failures.delete(key);
  }

  /** Number of tracked keys (tests). */
  get size(): number {
    return this.#failures.size;
  }
}

/** Throttle key of an account: the lowercase username (usernames are ASCII, unique case-insensitively). */
export const accountKey = (username: string): string => `user:${username.trim().toLowerCase()}`;

/** Throttle key of an account as seen from one client. */
export const accountClientKey = (username: string, ip: string | undefined): string => `${accountKey(username)}|${clientKey(ip)}`;

/** Throttle key for re-authentication inside a session. */
export const reauthKey = (userId: number): string => `uid:${userId}`;
