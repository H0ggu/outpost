import type { FastifyPluginAsync } from 'fastify';
import QRCode from 'qrcode';
import {
  API_ROUTES,
  type LoginResponse,
  type OkResponse,
  type SessionInfo,
  type SessionsResponse,
  type TotpSetupResponse,
  type UserPrefs,
} from '@outpost/shared/api';
import { z } from 'zod';
import {
  assertUsernameFree,
  changePasswordSchema,
  consumeInvite,
  findUserById,
  findUserByUsername,
  hasAdmin,
  insertUser,
  invalidInvite,
  isInviteUsable,
  loginSchema,
  prefsPatchSchema,
  recordTotpStep,
  setPasswordHash,
  setupSchema,
  signupSchema,
  toSessionUser,
  totpDisableSchema,
  totpEnableSchema,
  totpSetupSchema,
  updatePrefs,
} from '../auth/accounts.ts';
import { isKnownDevice, purgeStaleDevices, rememberDevice } from '../auth/devices.ts';
import { dummyPasswordHash, hashPassword, needsRehash, verifyPassword } from '../auth/password.ts';
import {
  clearSessionCookie,
  deleteSession,
  hashSessionToken,
  listUserSessions,
  optionalUser,
  purgeExpiredSessions,
  requireUser,
  revokeUserSessions,
  SESSION_COOKIE,
  startSession,
} from '../auth/session.ts';
import { createSetupTokenStore } from '../auth/setup.ts';
import {
  accountClientKey,
  accountKey,
  FAILURE_LIMITS,
  FailureThrottle,
  IP_LIMITS,
  ipRateLimit,
  clientKey,
  reauthKey,
} from '../auth/throttle.ts';
import { generateTotpSecret, otpauthUrl, TOTP_PENDING_TTL_MS, verifyTotp } from '../auth/totp.ts';
import { badRequest, conflict, forbidden, HttpError, notFound, unauthorized } from '../http/errors.ts';
import { parseBody, parseParams } from '../http/validate.ts';
import { readSettings } from '../settings.ts';

/**
 * Auth routes — PLAN §6 "Session, account and admin" and §10 (passwords, sessions, TOTP, setup).
 *
 * Endpoints (request/response types in @outpost/shared/api):
 *   - GET  /api/session (SessionInfo)
 *   - POST /api/setup (SetupRequest → LoginResponse): first admin via the setup token (src/auth/setup.ts);
 *     403 'forbidden' once any admin row exists, disabled or not — the same rule as setupRequired.
 *   - POST /api/login (LoginRequest → LoginResponse): generic 401 'unauthorized' for an unknown user
 *     or a wrong password (unknown users are checked against a dummy hash, so timing is equal);
 *     403 for a disabled account (only after the password matched); 401 'totp_required' when TOTP is
 *     on and the code is missing (`details.reason: 'missing'`) or wrong / replayed ('invalid').
 *     Setup, signup and login remember the browser as a known device (src/auth/devices.ts).
 *   - POST /api/logout (OkResponse; always succeeds and clears the cookie)
 *   - POST /api/signup (SignupRequest → LoginResponse): 403 'setup_required' before setup; by
 *     signupMode: closed → 403, invite → an unused unexpired code consumed atomically, open.
 *   - GET/PUT /api/me/prefs (UserPrefs / UpdatePrefsRequest → UserPrefs)
 *   - POST /api/me/password (ChangePasswordRequest → OkResponse): needs the current password, signs
 *     out every other session.
 *   - POST /api/me/totp/setup (TotpSetupRequest: the current password, required →
 *     TotpSetupResponse: pending secret, otpauth URI, QR as SVG and data: URL), /api/me/totp/enable
 *     (TotpEnableRequest: a code for the pending secret), /api/me/totp/disable (TotpDisableRequest:
 *     password or a current code)
 *   - GET /api/me/sessions (SessionsResponse), DELETE /api/me/sessions/:id (OkResponse; 404 if not yours)
 *
 * Throttling (src/auth/throttle.ts): per client with @fastify/rate-limit on setup, login, signup,
 * password and TOTP routes; failed sign-ins per account + client and (at a higher ceiling, known
 * devices exempt) per account; failed re-authentication inside a session per user; bad invite codes
 * per client. All answer 429 'rate_limited' with `details.retryAt` / `retryAfterSec`.
 *
 * Background: the setup token is ensured (generated + logged once) in onReady; expired sessions
 * and stale known devices are purged at startup and hourly (a local DB cleanup, so it runs
 * regardless of startWorkers).
 */

/** Expired sessions are purged this often. */
export const SESSION_PURGE_INTERVAL_MS = 60 * 60 * 1000;

const sessionIdParams = z.object({ id: z.string().regex(/^[0-9a-f]{64}$/, 'invalid session id') });

/** 401 `totp_required`: the password was right, a (valid) code is needed. */
const totpRequired = (reason: 'missing' | 'invalid'): HttpError =>
  new HttpError(
    401,
    'totp_required',
    reason === 'missing' ? 'Enter the code from your authenticator app' : 'That code is not valid; wait for the next one and try again',
    { reason },
  );

const authRoutes: FastifyPluginAsync = async app => {
  const { db, config } = app;
  const setup = createSetupTokenStore({ db, config, log: app.log });
  const clientFailures = new FailureThrottle(FAILURE_LIMITS.accountClient);
  const accountFailures = new FailureThrottle(FAILURE_LIMITS.account);
  const reauthFailures = new FailureThrottle(FAILURE_LIMITS.reauth);
  const inviteFailures = new FailureThrottle(FAILURE_LIMITS.invite);
  let purgeTimer: NodeJS.Timeout | null = null;

  const purge = (): void => {
    try {
      const n = purgeExpiredSessions(db);
      if (n) app.log.info(`purged ${n} expired session${n === 1 ? '' : 's'}`);
      purgeStaleDevices(db);
    } catch (err) {
      app.log.warn({ err }, 'could not purge expired sessions');
    }
  };

  /** Checks the current password inside a session (password change, TOTP setup), throttled per user. */
  const assertCurrentPassword = async (userId: number, password: string, reply: Parameters<FailureThrottle['assertAllowed']>[1]) => {
    const key = reauthKey(userId);
    reauthFailures.assertAllowed(key, reply, 'Too many wrong passwords or codes');
    const row = findUserById(db, userId);
    if (!row || !(await verifyPassword(password, row.password_hash))) {
      reauthFailures.fail(key);
      throw forbidden('Current password is incorrect');
    }
    return row;
  };

  app.addHook('onReady', async () => {
    setup.ensure();
    // Computed once per process, so the first login of an unknown user is not slower than the rest.
    await dummyPasswordHash();
    purge();
    purgeTimer = setInterval(purge, SESSION_PURGE_INTERVAL_MS);
    purgeTimer.unref();
  });
  app.addHook('onClose', async () => {
    if (purgeTimer) clearInterval(purgeTimer);
    purgeTimer = null;
  });

  // -------------------------------------------------------------------------
  // Session info, setup, login, logout, signup
  // -------------------------------------------------------------------------

  app.get(API_ROUTES.session, { preHandler: optionalUser }, async (req): Promise<SessionInfo> => {
    const settings = readSettings(db, config);
    return {
      user: req.user ? { ...req.user } : null,
      setupRequired: !hasAdmin(db),
      signupMode: settings.signupMode,
      anonymousBrowsing: settings.anonymousBrowsing,
      version: config.version,
      sourceUrl: config.sourceUrl,
    };
  });

  app.post(API_ROUTES.setup, { config: ipRateLimit(IP_LIMITS.setup) }, async (req, reply): Promise<LoginResponse> => {
    if (hasAdmin(db)) throw forbidden('Outpost is already set up; sign in instead');
    const body = parseBody(setupSchema, req.body ?? {});
    if (!setup.matches(body.token)) {
      // No token at all (e.g. the last admin row was removed by hand): make one and log it.
      setup.ensure();
      throw forbidden('Invalid setup token; use the one printed in the server log (or SETUP_TOKEN)');
    }
    const passwordHash = await hashPassword(body.password);
    const userId = db.tx(() => {
      if (hasAdmin(db)) throw forbidden('Outpost is already set up; sign in instead');
      return insertUser(db, { username: body.username, passwordHash, role: 'admin' });
    });
    setup.clear();
    req.log.info({ userId }, 'first admin created');
    startSession(req, reply, userId);
    rememberDevice(req, reply, userId);
    return { user: toSessionUser(findUserById(db, userId)!) };
  });

  app.post(API_ROUTES.login, { config: ipRateLimit(IP_LIMITS.login) }, async (req, reply): Promise<LoginResponse> => {
    const body = parseBody(loginSchema, req.body ?? {});
    const key = accountKey(body.username);
    const pairKey = accountClientKey(body.username, req.ip);
    clientFailures.assertAllowed(pairKey, reply, 'Too many failed sign-in attempts for this account from your address');
    if (!isKnownDevice(db, req, body.username)) {
      accountFailures.assertAllowed(
        key,
        reply,
        'Too many failed sign-in attempts for this account from many addresses (browsers that signed in to it before can still sign in)',
      );
    }
    const failed = (): void => {
      clientFailures.fail(pairKey);
      accountFailures.fail(key);
    };

    const user = findUserByUsername(db, body.username);
    const ok = await verifyPassword(body.password, user?.password_hash ?? (await dummyPasswordHash()));
    if (!user || !ok) {
      failed();
      throw unauthorized('Invalid username or password');
    }
    if (user.disabled) throw forbidden('This account has been disabled');
    if (user.totp_secret !== null) {
      if (!body.totp?.trim()) throw totpRequired('missing');
      const step = verifyTotp(user.totp_secret, body.totp, { lastStep: user.totp_last_step });
      if (step === null || !recordTotpStep(db, user.id, step)) {
        failed();
        throw totpRequired('invalid');
      }
    }
    // The per-account count is left to age out: a success here says nothing about other clients.
    clientFailures.reset(pairKey);
    if (needsRehash(user.password_hash)) setPasswordHash(db, user.id, await hashPassword(body.password));
    startSession(req, reply, user.id);
    rememberDevice(req, reply, user.id);
    return { user: toSessionUser(user) };
  });

  app.post(API_ROUTES.logout, async (req, reply): Promise<OkResponse> => {
    const token = req.cookies[SESSION_COOKIE];
    if (token && token.length <= 256) deleteSession(db, hashSessionToken(token));
    clearSessionCookie(reply, config);
    return { ok: true };
  });

  app.post(API_ROUTES.signup, { config: ipRateLimit(IP_LIMITS.signup) }, async (req, reply): Promise<LoginResponse> => {
    if (!hasAdmin(db)) throw new HttpError(403, 'setup_required', 'Outpost is not set up yet');
    const mode = readSettings(db, config).signupMode;
    if (mode === 'closed') throw forbidden('Sign-up is closed; ask an admin for an account');
    const body = parseBody(signupSchema, req.body ?? {});

    const ipKey = clientKey(req.ip);
    const invite = mode === 'invite' ? body.invite || null : null;
    if (mode === 'invite') {
      inviteFailures.assertAllowed(ipKey, reply, 'Too many invalid invite codes');
      if (!invite) throw new HttpError(403, 'forbidden', 'An invite code is required to sign up', { reason: 'invite_required' });
      if (!isInviteUsable(db, invite)) {
        inviteFailures.fail(ipKey);
        throw invalidInvite();
      }
    }
    assertUsernameFree(db, body.username);

    const passwordHash = await hashPassword(body.password);
    const userId = db.tx(() => {
      // Settings may have changed while the password was hashing.
      const current = readSettings(db, config).signupMode;
      if (current === 'closed' || (current === 'invite' && !invite)) throw forbidden('Sign-up is closed; ask an admin for an account');
      const id = insertUser(db, { username: body.username, passwordHash, role: 'user' });
      if (invite) consumeInvite(db, invite, id);
      return id;
    });
    req.log.info({ userId, invite: invite !== null }, 'account created');
    startSession(req, reply, userId);
    rememberDevice(req, reply, userId);
    return { user: toSessionUser(findUserById(db, userId)!) };
  });

  // -------------------------------------------------------------------------
  // /api/me/*
  // -------------------------------------------------------------------------

  app.get(API_ROUTES.me.prefs, { preHandler: requireUser }, async (req): Promise<UserPrefs> => req.user!.prefs);

  app.put(API_ROUTES.me.prefs, { preHandler: requireUser }, async (req): Promise<UserPrefs> => {
    const patch = parseBody(prefsPatchSchema, req.body ?? {});
    return updatePrefs(db, req.user!.id, patch);
  });

  app.post(
    API_ROUTES.me.password,
    { preHandler: requireUser, config: ipRateLimit(IP_LIMITS.password) },
    async (req, reply): Promise<OkResponse> => {
      const me = req.user!;
      const body = parseBody(changePasswordSchema, req.body ?? {});
      await assertCurrentPassword(me.id, body.currentPassword, reply);
      reauthFailures.reset(reauthKey(me.id));
      const hash = await hashPassword(body.newPassword);
      const revoked = db.tx(() => {
        setPasswordHash(db, me.id, hash);
        return revokeUserSessions(db, me.id, { except: req.sessionHash });
      });
      req.log.info({ userId: me.id, revoked }, 'password changed');
      return { ok: true };
    },
  );

  app.post(
    API_ROUTES.me.totpSetup,
    { preHandler: requireUser, config: ipRateLimit(IP_LIMITS.totp) },
    async (req, reply): Promise<TotpSetupResponse> => {
      const me = req.user!;
      const body = parseBody(totpSetupSchema, req.body ?? {});
      if (me.totpEnabled) throw conflict('Two-factor authentication is already on; turn it off first');
      await assertCurrentPassword(me.id, body.password, reply);
      reauthFailures.reset(reauthKey(me.id));
      const secret = generateTotpSecret();
      const now = Date.now();
      db.run('UPDATE users SET totp_pending_secret = ?, totp_pending_at = ? WHERE id = ?', [secret, now, me.id]);
      const uri = otpauthUrl(secret, me.username);
      const qr = { errorCorrectionLevel: 'M', margin: 2 } as const;
      const [qrSvg, qrDataUrl] = await Promise.all([
        QRCode.toString(uri, { ...qr, type: 'svg' }),
        QRCode.toDataURL(uri, { ...qr, width: 240 }),
      ]);
      return { secret, otpauthUrl: uri, qrSvg, qrDataUrl, expiresAt: now + TOTP_PENDING_TTL_MS };
    },
  );

  app.post(
    API_ROUTES.me.totpEnable,
    { preHandler: requireUser, config: ipRateLimit(IP_LIMITS.totp) },
    async (req, reply): Promise<OkResponse> => {
      const me = req.user!;
      const body = parseBody(totpEnableSchema, req.body ?? {});
      const key = reauthKey(me.id);
      reauthFailures.assertAllowed(key, reply, 'Too many wrong passwords or codes');
      const row = db.get<{ totp_secret: string | null; totp_pending_secret: string | null; totp_pending_at: number | null }>(
        'SELECT totp_secret, totp_pending_secret, totp_pending_at FROM users WHERE id = ?',
        [me.id],
      );
      if (row?.totp_secret) throw conflict('Two-factor authentication is already on');
      const pending = row?.totp_pending_secret ?? null;
      if (!pending || (row?.totp_pending_at ?? 0) + TOTP_PENDING_TTL_MS <= Date.now()) {
        throw badRequest('No two-factor setup in progress (or it expired); start again');
      }
      const step = verifyTotp(pending, body.code);
      if (step === null) {
        reauthFailures.fail(key);
        throw forbidden('That code is not valid; check the time on your device and try again');
      }
      const changed = db.run(
        `UPDATE users SET totp_secret = totp_pending_secret, totp_last_step = ?, totp_pending_secret = NULL, totp_pending_at = NULL
          WHERE id = ? AND totp_secret IS NULL AND totp_pending_secret = ?`,
        [step, me.id, pending],
      ).changes;
      if (changed !== 1) throw conflict('Two-factor setup changed meanwhile; start again');
      reauthFailures.reset(key);
      req.log.info({ userId: me.id }, 'TOTP enabled');
      return { ok: true };
    },
  );

  app.post(
    API_ROUTES.me.totpDisable,
    { preHandler: requireUser, config: ipRateLimit(IP_LIMITS.totp) },
    async (req, reply): Promise<OkResponse> => {
      const me = req.user!;
      const body = parseBody(totpDisableSchema, req.body ?? {});
      const key = reauthKey(me.id);
      reauthFailures.assertAllowed(key, reply, 'Too many wrong passwords or codes');
      const row = findUserById(db, me.id);
      if (!row?.totp_secret) throw conflict('Two-factor authentication is not on');
      let ok = body.password !== null && (await verifyPassword(body.password, row.password_hash));
      if (!ok && body.code !== null) {
        const step = verifyTotp(row.totp_secret, body.code, { lastStep: row.totp_last_step });
        ok = step !== null && recordTotpStep(db, me.id, step);
      }
      if (!ok) {
        reauthFailures.fail(key);
        throw forbidden('Wrong password or code');
      }
      db.run(
        'UPDATE users SET totp_secret = NULL, totp_last_step = NULL, totp_pending_secret = NULL, totp_pending_at = NULL WHERE id = ?',
        [me.id],
      );
      reauthFailures.reset(key);
      req.log.info({ userId: me.id }, 'TOTP disabled');
      return { ok: true };
    },
  );

  app.get(API_ROUTES.me.sessions, { preHandler: requireUser }, async (req): Promise<SessionsResponse> => ({
    sessions: listUserSessions(db, req.user!.id, req.sessionHash),
  }));

  app.delete(API_ROUTES.me.session(':id'), { preHandler: requireUser }, async (req, reply): Promise<OkResponse> => {
    const { id } = parseParams(sessionIdParams, req.params);
    const gone = db.run('DELETE FROM sessions WHERE id_hash = ? AND user_id = ?', [id, req.user!.id]).changes;
    if (!gone) throw notFound('No such session');
    if (id === req.sessionHash) clearSessionCookie(reply, config);
    return { ok: true };
  });
};

export default authRoutes;
