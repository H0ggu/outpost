/**
 * Throttling for the auth endpoints (PLAN §10).
 *
 * Two layers:
 * 1. **Per IP** — `@fastify/rate-limit` (registered with `global: false` in app.ts), opted in per
 *    route with `config: ipRateLimit(LIMITS.login)`. Counts every request to that route from one
 *    client IP (`req.ip`, which honours TRUSTED_PROXIES).
 * 2. **Per account on failures** — `FailureThrottle`, an in-memory sliding window keyed by the
 *    lowercase username: wrong passwords, wrong TOTP codes, wrong current passwords. Once a key has
 *    `max` failures inside `windowMs`, every attempt for it is refused (even a correct one) until the
 *    oldest failure leaves the window. A successful login clears the key. The same class keys
 *    invite-code failures by IP.
 *
 * Both answer 429 `rate_limited` with `details: { retryAt, retryAfterSec }` and a `Retry-After` header.
 * State is per process (one Outpost process per instance); a restart clears it.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
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

/** Failure budgets of the in-memory throttles. */
export const FAILURE_LIMITS = {
  /** Wrong password / TOTP code / current password, per account. */
  account: { max: 10, windowMs: 15 * MIN },
  /** Unknown, used or expired invite codes, per IP. */
  invite: { max: 5, windowMs: 15 * MIN },
} as const;

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
