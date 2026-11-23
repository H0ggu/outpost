import type { FastifyPluginAsync } from 'fastify';
import { API_ROUTES, type SessionInfo } from '@outpost/shared/api';
import { optionalUser } from '../auth/session.ts';
import { readSettings } from '../settings.ts';

/**
 * Auth routes — PLAN §6 "Session, account and admin" and §10 (passwords, sessions, TOTP, setup).
 *
 * Endpoints (request/response types in @outpost/shared/api):
 *   - GET  /api/session (SessionInfo)            ← minimal version below; replace freely
 *   - POST /api/setup (SetupRequest → LoginResponse; first admin via SETUP_TOKEN; 403 'forbidden'
 *     once any admin row exists, disabled or not — the same rule as setupRequired below)
 *   - POST /api/login (LoginRequest → LoginResponse; 401 'totp_required' when a code is needed)
 *   - POST /api/logout (OkResponse)
 *   - POST /api/signup (SignupRequest → LoginResponse; honours signupMode)
 *   - GET/PUT /api/me/prefs (UserPrefs / UpdatePrefsRequest)
 *   - POST /api/me/password (ChangePasswordRequest)
 *   - POST /api/me/totp/setup (TotpSetupResponse), /api/me/totp/enable (TotpEnableRequest),
 *     /api/me/totp/disable (TotpDisableRequest)
 *   - GET /api/me/sessions (SessionsResponse), DELETE /api/me/sessions/:id
 *
 * The setup token (SETUP_TOKEN, or a generated one printed to the log once while no admin
 * exists) is handled from this plugin, e.g. in app.addHook('onReady', ...).
 * Throttle login/signup per IP and per username (@fastify/rate-limit is registered with
 * `global: false`; opt in per route with `config: { rateLimit: {...} }`).
 *
 * TODO(auth): implement. Session cookie helpers: src/auth/session.ts. Migrations 100–199.
 */
const authRoutes: FastifyPluginAsync = async app => {
  app.get(API_ROUTES.session, { preHandler: optionalUser }, async (req): Promise<SessionInfo> => {
    const settings = readSettings(app.db, app.config);
    // Setup is open only while no admin row exists at all — a disabled admin still closes it, so a
    // permanent SETUP_TOKEN in env can never mint a second admin. POST /api/setup enforces the same rule.
    const hasAdmin = app.db.get("SELECT 1 AS x FROM users WHERE role = 'admin' LIMIT 1") !== undefined;
    return {
      user: req.user ? { ...req.user } : null,
      setupRequired: !hasAdmin,
      signupMode: settings.signupMode,
      anonymousBrowsing: settings.anonymousBrowsing,
      version: app.config.version,
    };
  });

  // TODO(auth): setup, login, logout, signup, /api/me/*
};

export default authRoutes;
