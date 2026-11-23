/**
 * The one-time setup token that creates the first admin (PLAN §3 SETUP_TOKEN, §10).
 *
 * - SETUP_TOKEN set in env: that value is the token (never logged).
 * - Otherwise, while no admin row exists, a random token is generated when the app is ready and
 *   logged once, clearly, at `warn` level. It lives only in memory: a restart before setup simply
 *   generates and logs a new one. It is forgotten as soon as the first admin exists.
 * - `POST /api/setup` compares in constant time (both sides are hashed to equal length first).
 * - Setup stays closed while any admin row exists, disabled or not (the same rule as
 *   `SessionInfo.setupRequired`), so a permanent SETUP_TOKEN in env can never mint a second admin.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import { hasAdmin } from './accounts.ts';

/** Random bytes in a generated setup token. */
export const SETUP_TOKEN_BYTES = 24;

/** Holder of the current setup token (one per app). */
export interface SetupTokenStore {
  /**
   * Makes sure a token exists while setup is open: generates and logs one when SETUP_TOKEN is not
   * set. Returns the token, or null when setup is closed.
   */
  ensure(): string | null;
  /** Constant-time check of a submitted token. False when there is no token. */
  matches(given: string): boolean;
  /** Forgets the generated token (after the first admin was created). */
  clear(): void;
  /** Whether the token came from SETUP_TOKEN. */
  readonly fromEnv: boolean;
}

const digest = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();

/** Log levels at which a `warn` line is not written. */
const QUIET_LEVELS: ReadonlySet<string> = new Set(['error', 'fatal', 'silent']);

/** Creates the store. `log` receives the one-time announcement. */
export function createSetupTokenStore(deps: { db: Db; config: Config; log: FastifyBaseLogger }): SetupTokenStore {
  const { db, config, log } = deps;
  let generated: string | null = null;
  let announcedEnv = false;

  const current = (): string | null => config.setupToken ?? generated;

  return {
    fromEnv: config.setupToken !== null,
    ensure() {
      if (hasAdmin(db)) {
        generated = null;
        return null;
      }
      if (config.setupToken) {
        if (!announcedEnv) {
          announcedEnv = true;
          log.warn('Outpost setup: no admin account exists yet. Open /setup and enter the SETUP_TOKEN from your environment.');
        }
        return config.setupToken;
      }
      if (!generated) {
        generated = randomBytes(SETUP_TOKEN_BYTES).toString('base64url');
        const where = config.publicOrigin ? `${config.publicOrigin}/setup` : '/setup';
        const msg =
          `Outpost setup: no admin account exists yet. Open ${where} and enter this one-time setup token: ${generated}` +
          ' (it changes on every restart until setup is done; set SETUP_TOKEN to choose your own)';
        log.warn({ setupToken: generated }, msg);
        // LOG_LEVEL=error/fatal/silent would swallow it, and without it nobody can finish setup.
        if (QUIET_LEVELS.has(log.level) && config.env !== 'test') process.stderr.write(`${msg}\n`);
      }
      return generated;
    },
    matches(given) {
      const token = current();
      // Always hash and compare, even without a token, so timing says nothing.
      const ok = timingSafeEqual(digest(given), digest(token ?? `\u0000${randomBytes(8).toString('hex')}`));
      return token !== null && ok;
    },
    clear() {
      generated = null;
    },
  };
}
