import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import type { LightMyRequestResponse } from 'fastify';
import {
  API_ROUTES,
  DEFAULT_PREFS,
  SESSION_COOKIE,
  type LoginResponse,
  type SessionInfo,
  type SessionsResponse,
  type TotpSetupResponse,
  type UserPrefs,
} from '@outpost/shared/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { hashSessionToken, purgeExpiredSessions, SESSION_TTL_MS } from '../src/auth/session.ts';
import { FAILURE_LIMITS, IP_LIMITS } from '../src/auth/throttle.ts';
import { totpCode } from '../src/auth/totp.ts';
import { loadConfig } from '../src/config.ts';
import { openDb } from '../src/db/index.ts';
import { migrate } from '../src/db/migrate.ts';
import { writeSettings } from '../src/settings.ts';
import { createUserSession, makeTestApp, mutationHeaders, noNetworkFetch, type TestApp } from './helpers.ts';

const SETUP_TOKEN = 'setup-token-for-tests-0123456789';
const ADMIN_PW = 'admin password 1';
const USER_PW = 'user password 1';

let ipSeq = 0;
/** A fresh client IP, so per-IP rate limits of one test don't leak into another. */
const nextIp = (): string => {
  ipSeq++;
  return `10.1.${ipSeq >> 8}.${ipSeq & 255}`;
};

interface ReqOpts {
  cookie?: string | null;
  ip?: string;
  headers?: Record<string, string>;
}

const post = (t: TestApp, url: string, payload?: object, o: ReqOpts = {}): Promise<LightMyRequestResponse> =>
  t.app.inject({
    method: 'POST',
    url,
    ...(payload === undefined ? {} : { payload }),
    headers: { ...mutationHeaders, ...(o.cookie ? { cookie: o.cookie } : {}), ...o.headers },
    remoteAddress: o.ip ?? nextIp(),
  });

const send = (t: TestApp, method: 'PUT' | 'DELETE', url: string, payload?: object, o: ReqOpts = {}): Promise<LightMyRequestResponse> =>
  t.app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload }),
    headers: { ...mutationHeaders, ...(o.cookie ? { cookie: o.cookie } : {}) },
    remoteAddress: o.ip ?? nextIp(),
  });

const get = (t: TestApp, url: string, cookie?: string | null): Promise<LightMyRequestResponse> =>
  t.app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });

/** `outpost_session=<token>` from a response's Set-Cookie, or null. */
const sessionCookie = (res: LightMyRequestResponse): string | null => {
  const c = res.cookies.find(x => x.name === SESSION_COOKIE);
  return c && c.value ? `${SESSION_COOKIE}=${c.value}` : null;
};

const sessionOf = async (t: TestApp, cookie: string | null): Promise<SessionInfo> => (await get(t, API_ROUTES.session, cookie)).json();

const tokenOf = (cookie: string): string => cookie.slice(SESSION_COOKIE.length + 1);

async function setupAdmin(t: TestApp, username = 'Admin'): Promise<string> {
  const res = await post(t, API_ROUTES.setup, { token: SETUP_TOKEN, username, password: ADMIN_PW });
  expect(res.statusCode).toBe(200);
  return sessionCookie(res)!;
}

async function login(t: TestApp, username: string, password: string, extra: { totp?: string; ip?: string } = {}) {
  const res = await post(t, API_ROUTES.login, { username, password, ...(extra.totp ? { totp: extra.totp } : {}) }, { ip: extra.ip ?? nextIp() });
  return { res, cookie: sessionCookie(res) };
}

async function signup(t: TestApp, username: string, password = USER_PW, invite?: string, ip?: string) {
  const res = await post(t, API_ROUTES.signup, { username, password, ...(invite !== undefined ? { invite } : {}) }, { ip: ip ?? nextIp() });
  return { res, cookie: sessionCookie(res) };
}

// ---------------------------------------------------------------------------

describe('setup (SETUP_TOKEN from env)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await makeTestApp({ env: { SETUP_TOKEN } });
  });
  afterAll(async () => {
    await t.close();
  });

  it('reports setupRequired and refuses signup until an admin exists', async () => {
    expect((await sessionOf(t, null)).setupRequired).toBe(true);
    writeSettings(t.db, { signupMode: 'open' });
    const res = await post(t, API_ROUTES.signup, { username: 'early', password: USER_PW });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('setup_required');
    writeSettings(t.db, { signupMode: 'closed' });
  });

  it('rejects a wrong or missing token', async () => {
    const wrong = await post(t, API_ROUTES.setup, { token: `${SETUP_TOKEN}x`, username: 'Admin', password: ADMIN_PW });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json().error.code).toBe('forbidden');
    expect(sessionCookie(wrong)).toBeNull();
    const missing = await post(t, API_ROUTES.setup, { username: 'Admin', password: ADMIN_PW });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe('validation');
    expect(t.db.value('SELECT COUNT(*) FROM users')).toBe(0);
  });

  it('validates the username and password', async () => {
    const badName = await post(t, API_ROUTES.setup, { token: SETUP_TOKEN, username: 'x', password: ADMIN_PW });
    expect(badName.statusCode).toBe(400);
    expect(badName.json().error.message).toMatch(/username/i);
    const weak = await post(t, API_ROUTES.setup, { token: SETUP_TOKEN, username: 'Admin', password: 'short' });
    expect(weak.statusCode).toBe(400);
    expect(weak.json().error.message).toMatch(/at least 8/);
  });

  it('creates the first admin, signs them in and closes setup', async () => {
    const res = await post(t, API_ROUTES.setup, { token: ` ${SETUP_TOKEN} `, username: 'Admin', password: ADMIN_PW });
    expect(res.statusCode).toBe(200);
    const body = res.json<LoginResponse>();
    expect(body.user).toMatchObject({ username: 'Admin', role: 'admin', totpEnabled: false, prefs: DEFAULT_PREFS });

    const cookie = res.cookies.find(c => c.name === SESSION_COOKIE)!;
    expect(cookie.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe('Lax');
    expect(cookie.path).toBe('/');
    expect(cookie.secure).toBeFalsy();
    expect(cookie.maxAge).toBe(SESSION_TTL_MS / 1000);

    // Only the hash is stored.
    const row = t.db.get<{ id_hash: string }>('SELECT id_hash FROM sessions');
    expect(row!.id_hash).toBe(hashSessionToken(cookie.value));
    expect(t.db.value('SELECT COUNT(*) FROM sessions WHERE id_hash = ?', [cookie.value])).toBe(0);
    // The password is stored as scrypt.
    expect(t.db.value<string>('SELECT password_hash FROM users')).toMatch(/^\$scrypt\$ln=15,r=8,p=1\$/);

    const info = await sessionOf(t, sessionCookie(res));
    expect(info.setupRequired).toBe(false);
    expect(info.user?.username).toBe('Admin');
  });

  it('answers 403 once an admin exists, even with the right token', async () => {
    const again = await post(t, API_ROUTES.setup, { token: SETUP_TOKEN, username: 'Second', password: ADMIN_PW });
    expect(again.statusCode).toBe(403);
    expect(again.json().error.code).toBe('forbidden');
    expect(t.db.value("SELECT COUNT(*) FROM users WHERE role = 'admin'")).toBe(1);
  });
});

describe('setup (generated token)', () => {
  const build = async (opts: { seedAdmin?: boolean; env?: Record<string, string> } = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'outpost-auth-test-'));
    const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: dir, LOG_LEVEL: 'warn', ...opts.env });
    const db = openDb(config.dbPath);
    migrate(db);
    if (opts.seedAdmin) createUserSession(db, { username: 'existing', role: 'admin' });
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _enc, cb) {
        lines.push(chunk.toString('utf8'));
        cb();
      },
    });
    const app = await buildApp({ config, db, logger: { level: 'warn', stream }, fetch: noNetworkFetch });
    await app.ready();
    const t: TestApp = {
      app,
      db,
      config,
      dir,
      async close() {
        await app.close();
        db.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
    return { t, lines };
  };

  it('generates a token, logs it once and accepts it', async () => {
    const { t, lines } = await build();
    try {
      const logged = lines.map(l => JSON.parse(l) as { level: number; msg: string; setupToken?: string }).filter(l => l.setupToken);
      expect(logged).toHaveLength(1);
      const token = logged[0]!.setupToken!;
      expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
      expect(logged[0]!.msg).toContain(token);
      expect(logged[0]!.msg).toContain('/setup');

      const wrong = await post(t, API_ROUTES.setup, { token: 'nope-nope-nope-nope', username: 'Boss', password: ADMIN_PW });
      expect(wrong.statusCode).toBe(403);
      const ok = await post(t, API_ROUTES.setup, { token, username: 'Boss', password: ADMIN_PW });
      expect(ok.statusCode).toBe(200);
      expect(ok.json<LoginResponse>().user.role).toBe('admin');
      // Not logged again, and now refused.
      expect(lines.filter(l => l.includes('setupToken'))).toHaveLength(1);
      expect((await post(t, API_ROUTES.setup, { token, username: 'Boss2', password: ADMIN_PW })).statusCode).toBe(403);
    } finally {
      await t.close();
    }
  });

  it('logs no token when an admin already exists or SETUP_TOKEN is set', async () => {
    const a = await build({ seedAdmin: true });
    try {
      expect(a.lines.some(l => l.includes('setupToken'))).toBe(false);
      expect((await sessionOf(a.t, null)).setupRequired).toBe(false);
    } finally {
      await a.t.close();
    }
    const b = await build({ env: { SETUP_TOKEN } });
    try {
      expect(b.lines.some(l => l.includes(SETUP_TOKEN))).toBe(false);
      expect(b.lines.some(l => l.includes('setupToken'))).toBe(false);
      expect(b.lines.some(l => l.includes('SETUP_TOKEN'))).toBe(true);
    } finally {
      await b.t.close();
    }
  });
});

// ---------------------------------------------------------------------------

describe('login, logout and sessions', () => {
  let t: TestApp;
  let adminCookie: string;
  beforeAll(async () => {
    t = await makeTestApp({ env: { SETUP_TOKEN } });
    adminCookie = await setupAdmin(t);
    writeSettings(t.db, { signupMode: 'open' });
    expect((await signup(t, 'Alice')).res.statusCode).toBe(200);
  });
  afterAll(async () => {
    await t.close();
  });

  it('signs in case-insensitively and returns the SessionUser', async () => {
    const { res, cookie } = await login(t, 'alice', USER_PW);
    expect(res.statusCode).toBe(200);
    expect(res.json<LoginResponse>().user).toMatchObject({ username: 'Alice', role: 'user', totpEnabled: false });
    expect((await sessionOf(t, cookie)).user?.username).toBe('Alice');
  });

  it('gives the same generic error for an unknown user and a wrong password', async () => {
    const unknown = await login(t, 'nobody', USER_PW);
    const wrong = await login(t, 'Alice', 'wrong password');
    for (const { res, cookie } of [unknown, wrong]) {
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: { code: 'unauthorized', message: 'Invalid username or password' } });
      expect(cookie).toBeNull();
    }
  });

  it('validates the body', async () => {
    const res = await post(t, API_ROUTES.login, { username: 'Alice' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation');
    const empty = await post(t, API_ROUTES.login);
    expect(empty.statusCode).toBe(400);
  });

  it('rejects disabled users (after the password matched) and ignores their sessions', async () => {
    expect((await signup(t, 'Dora')).res.statusCode).toBe(200);
    const { cookie } = await login(t, 'Dora', USER_PW);
    t.db.run("UPDATE users SET disabled = 1 WHERE username = 'Dora'");
    const res = (await login(t, 'Dora', USER_PW)).res;
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('forbidden');
    expect((await login(t, 'Dora', 'not her password')).res.statusCode).toBe(401);
    expect((await sessionOf(t, cookie)).user).toBeNull();
  });

  it('logout deletes the session and clears the cookie; it is idempotent', async () => {
    const { cookie } = await login(t, 'Alice', USER_PW);
    const before = t.db.value<number>('SELECT COUNT(*) FROM sessions');
    const res = await post(t, API_ROUTES.logout, undefined, { cookie });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    const cleared = res.cookies.find(c => c.name === SESSION_COOKIE)!;
    expect(cleared.value).toBe('');
    expect(t.db.value<number>('SELECT COUNT(*) FROM sessions')).toBe(before! - 1);
    expect((await sessionOf(t, cookie)).user).toBeNull();
    expect((await post(t, API_ROUTES.logout)).statusCode).toBe(200);
  });

  it('replaces the session a request came with when signing in again', async () => {
    const { cookie } = await login(t, 'Alice', USER_PW);
    const hash = hashSessionToken(tokenOf(cookie!));
    const res = await post(t, API_ROUTES.login, { username: 'Alice', password: USER_PW }, { cookie });
    expect(res.statusCode).toBe(200);
    expect(t.db.value('SELECT COUNT(*) FROM sessions WHERE id_hash = ?', [hash])).toBe(0);
    expect(sessionCookie(res)).not.toBe(cookie);
  });

  it('lists sessions with the current one marked, and revokes one', async () => {
    const a = (await login(t, 'Alice', USER_PW)).cookie!;
    const b = (await login(t, 'Alice', USER_PW)).cookie!;
    const list = (await get(t, API_ROUTES.me.sessions, a)).json<SessionsResponse>().sessions;
    expect(list.length).toBeGreaterThanOrEqual(2);
    const current = list.filter(s => s.current);
    expect(current).toHaveLength(1);
    expect(current[0]!.id).toBe(hashSessionToken(tokenOf(a)));
    expect(current[0]!.ip).toMatch(/^10\.1\./);
    const other = list.find(s => s.id === hashSessionToken(tokenOf(b)))!;
    expect(other).toMatchObject({ current: false });
    expect(other.expiresAt).toBeGreaterThan(Date.now() + SESSION_TTL_MS - 60_000);

    const del = await send(t, 'DELETE', API_ROUTES.me.session(other.id), undefined, { cookie: a });
    expect(del.statusCode).toBe(200);
    expect((await sessionOf(t, b)).user).toBeNull();
    expect((await sessionOf(t, a)).user?.username).toBe('Alice');
    // Gone now; malformed ids are a validation error.
    expect((await send(t, 'DELETE', API_ROUTES.me.session(other.id), undefined, { cookie: a })).statusCode).toBe(404);
    expect((await send(t, 'DELETE', API_ROUTES.me.session('xyz'), undefined, { cookie: a })).statusCode).toBe(400);
  });

  it("cannot see or revoke another user's sessions", async () => {
    const alice = (await login(t, 'Alice', USER_PW)).cookie!;
    const adminHash = hashSessionToken(tokenOf(adminCookie));
    const list = (await get(t, API_ROUTES.me.sessions, alice)).json<SessionsResponse>().sessions;
    expect(list.some(s => s.id === adminHash)).toBe(false);
    expect((await send(t, 'DELETE', API_ROUTES.me.session(adminHash), undefined, { cookie: alice })).statusCode).toBe(404);
    expect((await sessionOf(t, adminCookie)).user?.username).toBe('Admin');
  });

  it('revoking the current session clears the cookie', async () => {
    const c = (await login(t, 'Alice', USER_PW)).cookie!;
    const res = await send(t, 'DELETE', API_ROUTES.me.session(hashSessionToken(tokenOf(c))), undefined, { cookie: c });
    expect(res.statusCode).toBe(200);
    expect(res.cookies.find(x => x.name === SESSION_COOKIE)?.value).toBe('');
    expect((await sessionOf(t, c)).user).toBeNull();
  });

  it('requires a session for /api/me/*', async () => {
    expect((await get(t, API_ROUTES.me.sessions)).statusCode).toBe(401);
    expect((await get(t, API_ROUTES.me.prefs)).statusCode).toBe(401);
    expect((await post(t, API_ROUTES.me.password, { currentPassword: 'x', newPassword: 'yyyyyyyy' })).statusCode).toBe(401);
    expect((await post(t, API_ROUTES.me.totpSetup)).statusCode).toBe(401);
  });

  it('slides the expiry (throttled) and re-sends the cookie', async () => {
    const c = (await login(t, 'Alice', USER_PW)).cookie!;
    const hash = hashSessionToken(tokenOf(c));
    // Fresh session: no write, no cookie.
    const fresh = await get(t, API_ROUTES.session, c);
    expect(fresh.cookies.find(x => x.name === SESSION_COOKIE)).toBeUndefined();

    const old = Date.now() - 5 * 60_000;
    t.db.run('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id_hash = ?', [old, Date.now() + 3_600_000, hash]);
    const res = await t.app.inject({ url: API_ROUTES.session, headers: { cookie: c, 'user-agent': 'TestBrowser/1.0' } });
    expect(res.json<SessionInfo>().user?.username).toBe('Alice');
    const row = t.db.get<{ last_seen_at: number; expires_at: number; user_agent: string }>(
      'SELECT last_seen_at, expires_at, user_agent FROM sessions WHERE id_hash = ?',
      [hash],
    )!;
    expect(row.last_seen_at).toBeGreaterThan(old);
    expect(row.expires_at).toBeGreaterThan(Date.now() + SESSION_TTL_MS - 60_000);
    expect(row.user_agent).toBe('TestBrowser/1.0');
    const refreshed = res.cookies.find(x => x.name === SESSION_COOKIE)!;
    expect(`${SESSION_COOKIE}=${refreshed.value}`).toBe(c);
    expect(refreshed.maxAge).toBe(SESSION_TTL_MS / 1000);
  });

  it('ignores expired sessions and purges them', async () => {
    const c = (await login(t, 'Alice', USER_PW)).cookie!;
    const hash = hashSessionToken(tokenOf(c));
    t.db.run('UPDATE sessions SET expires_at = ? WHERE id_hash = ?', [Date.now() - 1, hash]);
    expect((await sessionOf(t, c)).user).toBeNull();
    expect((await get(t, API_ROUTES.me.sessions, c)).statusCode).toBe(401);
    expect(purgeExpiredSessions(t.db)).toBeGreaterThanOrEqual(1);
    expect(t.db.value('SELECT COUNT(*) FROM sessions WHERE id_hash = ?', [hash])).toBe(0);
  });

  it('purges expired sessions when the app starts', async () => {
    const t2 = await makeTestApp({ env: { SETUP_TOKEN } });
    try {
      // Seed before ready: close and rebuild on the same DB file.
      const { cookie } = createUserSession(t2.db, { username: 'old' });
      t2.db.run('UPDATE sessions SET expires_at = 1');
      await t2.app.close();
      const app = await buildApp({ config: t2.config, db: t2.db, logger: false, fetch: noNetworkFetch });
      await app.ready();
      expect(t2.db.value('SELECT COUNT(*) FROM sessions')).toBe(0);
      expect(cookie).toBeTruthy();
      await app.close();
    } finally {
      t2.db.close();
      rmSync(t2.dir, { recursive: true, force: true });
    }
  });

  it('rehashes passwords stored with weaker parameters on login', async () => {
    const id = t.db.value<number>("SELECT id FROM users WHERE username = 'Alice'")!;
    // A valid hash with a lower cost (ln=10) for the same password.
    const { scrypt } = await import('node:crypto');
    const salt = Buffer.from('c2FsdHNhbHRzYWx0c2FsdA', 'base64');
    const key = await new Promise<Buffer>((res, rej) =>
      scrypt(USER_PW, salt, 64, { N: 1024, r: 8, p: 1 }, (e, k) => (e ? rej(e) : res(k))),
    );
    const weakHash = `$scrypt$ln=10,r=8,p=1$${salt.toString('base64').replace(/=+$/, '')}$${key.toString('base64').replace(/=+$/, '')}`;
    t.db.run('UPDATE users SET password_hash = ? WHERE id = ?', [weakHash, id]);
    expect((await login(t, 'Alice', USER_PW)).res.statusCode).toBe(200);
    expect(t.db.value<string>('SELECT password_hash FROM users WHERE id = ?', [id])).toMatch(/^\$scrypt\$ln=15,/);
  });
});

// ---------------------------------------------------------------------------

describe('signup modes and invites', () => {
  let t: TestApp;
  let adminCookie: string;
  beforeAll(async () => {
    t = await makeTestApp({ env: { SETUP_TOKEN } });
    adminCookie = await setupAdmin(t);
  });
  afterAll(async () => {
    await t.close();
  });

  const newInvite = async (expiresInDays?: number): Promise<string> => {
    const res = await post(t, API_ROUTES.admin.invites, expiresInDays === undefined ? {} : { expiresInDays }, { cookie: adminCookie });
    expect(res.statusCode).toBe(200);
    return res.json<{ code: string }>().code;
  };

  it('closed: 403', async () => {
    writeSettings(t.db, { signupMode: 'closed' });
    const { res, cookie } = await signup(t, 'closedguy');
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('forbidden');
    expect(cookie).toBeNull();
  });

  it('open: creates a user, signs them in; usernames are unique case-insensitively', async () => {
    writeSettings(t.db, { signupMode: 'open' });
    const { res, cookie } = await signup(t, 'OpenUser', USER_PW, 'ignored-in-open-mode');
    expect(res.statusCode).toBe(200);
    expect(res.json<LoginResponse>().user).toMatchObject({ username: 'OpenUser', role: 'user' });
    expect((await sessionOf(t, cookie)).user?.username).toBe('OpenUser');
    const dup = await signup(t, 'openuser');
    expect(dup.res.statusCode).toBe(409);
    expect(dup.res.json().error.code).toBe('conflict');
    const dupAdmin = await signup(t, 'ADMIN');
    expect(dupAdmin.res.statusCode).toBe(409);
  });

  it('validates username and password', async () => {
    writeSettings(t.db, { signupMode: 'open' });
    expect((await signup(t, 'bad name')).res.statusCode).toBe(400);
    expect((await signup(t, 'goodname', 'short')).res.statusCode).toBe(400);
    expect((await signup(t, 'goodname', 'x'.repeat(300))).res.statusCode).toBe(400);
  });

  it('invite: requires a valid code and consumes it once', async () => {
    writeSettings(t.db, { signupMode: 'invite' });
    const missing = await signup(t, 'invitee');
    expect(missing.res.statusCode).toBe(403);
    expect(missing.res.json().error.details).toEqual({ reason: 'invite_required' });
    const bogus = await signup(t, 'invitee', USER_PW, 'not-a-real-code');
    expect(bogus.res.statusCode).toBe(403);
    expect(bogus.res.json().error.details).toEqual({ reason: 'invite_invalid' });

    const code = await newInvite(7);
    const ok = await signup(t, 'invitee', USER_PW, code);
    expect(ok.res.statusCode).toBe(200);
    const row = t.db.get<{ used_by: number; used_at: number }>('SELECT used_by, used_at FROM invites WHERE code = ?', [code])!;
    expect(row.used_by).toBe(ok.res.json<LoginResponse>().user.id);
    expect(row.used_at).toBeGreaterThan(0);

    const reused = await signup(t, 'second', USER_PW, code);
    expect(reused.res.statusCode).toBe(403);
    expect(t.db.value("SELECT COUNT(*) FROM users WHERE username = 'second'")).toBe(0);
  });

  it('invite: refuses expired codes and does not burn a code on a taken username', async () => {
    writeSettings(t.db, { signupMode: 'invite' });
    const expired = await newInvite(1);
    t.db.run('UPDATE invites SET expires_at = ? WHERE code = ?', [Date.now() - 1000, expired]);
    expect((await signup(t, 'lateguy', USER_PW, expired)).res.statusCode).toBe(403);

    const code = await newInvite();
    const taken = await signup(t, 'INVITEE', USER_PW, code);
    expect(taken.res.statusCode).toBe(409);
    expect(t.db.value('SELECT used_at FROM invites WHERE code = ?', [code])).toBeNull();
    expect((await signup(t, 'freshname', USER_PW, code)).res.statusCode).toBe(200);
  });

  it('invite: two racing signups cannot share one code', async () => {
    writeSettings(t.db, { signupMode: 'invite' });
    const code = await newInvite();
    const [a, b] = await Promise.all([signup(t, 'racer1', USER_PW, code), signup(t, 'racer2', USER_PW, code)]);
    const codes = [a.res.statusCode, b.res.statusCode].sort();
    expect(codes).toEqual([200, 403]);
    expect(t.db.value("SELECT COUNT(*) FROM users WHERE username IN ('racer1', 'racer2')")).toBe(1);
  });

  it('invite: throttles an IP after repeated bad codes', async () => {
    writeSettings(t.db, { signupMode: 'invite' });
    const ip = nextIp();
    // The invite budget is below the per-IP signup limit, so this 429 comes from the invite throttle.
    expect(FAILURE_LIMITS.invite.max).toBeLessThan(IP_LIMITS.signup.max);
    for (let i = 0; i < FAILURE_LIMITS.invite.max; i++) {
      expect((await signup(t, `guess${i}`, USER_PW, `bad-${i}`, ip)).res.statusCode).toBe(403);
    }
    const blocked = await signup(t, 'guessx', USER_PW, 'bad-x', ip);
    expect(blocked.res.statusCode).toBe(429);
    expect(blocked.res.json().error.code).toBe('rate_limited');
    expect(blocked.res.json().error.message).toMatch(/invite/);
    // Another IP may still use a valid code.
    expect((await signup(t, 'guessok', USER_PW, await newInvite())).res.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------

describe('prefs and password change', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await makeTestApp({ env: { SETUP_TOKEN } });
    await setupAdmin(t);
    writeSettings(t.db, { signupMode: 'open' });
  });
  afterAll(async () => {
    await t.close();
  });

  it('GET returns defaults; PUT merges a subset and returns the full prefs', async () => {
    const { cookie } = await signup(t, 'prefsuser');
    expect((await get(t, API_ROUTES.me.prefs, cookie)).json()).toEqual(DEFAULT_PREFS);
    const res = await send(t, 'PUT', API_ROUTES.me.prefs, { theme: 'light', pieceSet: 'merida' }, { cookie });
    expect(res.statusCode).toBe(200);
    const prefs = res.json<UserPrefs>();
    expect(prefs).toEqual({ ...DEFAULT_PREFS, theme: 'light', pieceSet: 'merida' });
    const res2 = await send(t, 'PUT', API_ROUTES.me.prefs, { timezone: 'utc' }, { cookie });
    expect(res2.json<UserPrefs>()).toEqual({ ...prefs, timezone: 'utc' });
    expect((await get(t, API_ROUTES.me.prefs, cookie)).json()).toEqual({ ...prefs, timezone: 'utc' });
    expect((await sessionOf(t, cookie)).user?.prefs.theme).toBe('light');
  });

  it('rejects invalid values and unknown keys', async () => {
    const { cookie } = await signup(t, 'prefsuser2');
    expect((await send(t, 'PUT', API_ROUTES.me.prefs, { theme: 'neon' }, { cookie })).statusCode).toBe(400);
    expect((await send(t, 'PUT', API_ROUTES.me.prefs, { pieceSet: 'alpha' }, { cookie })).statusCode).toBe(400);
    expect((await send(t, 'PUT', API_ROUTES.me.prefs, { admin: true }, { cookie })).statusCode).toBe(400);
    expect((await get(t, API_ROUTES.me.prefs, cookie)).json()).toEqual(DEFAULT_PREFS);
    expect((await send(t, 'PUT', API_ROUTES.me.prefs, { theme: 'dark' })).statusCode).toBe(401);
  });

  it('password change needs the current password and signs out other sessions', async () => {
    const { cookie: a } = await signup(t, 'pwuser');
    const b = (await login(t, 'pwuser', USER_PW)).cookie!;

    const wrong = await post(t, API_ROUTES.me.password, { currentPassword: 'nope nope', newPassword: 'brand new pw' }, { cookie: a });
    expect(wrong.statusCode).toBe(403);
    const weak = await post(t, API_ROUTES.me.password, { currentPassword: USER_PW, newPassword: 'short' }, { cookie: a });
    expect(weak.statusCode).toBe(400);

    const ok = await post(t, API_ROUTES.me.password, { currentPassword: USER_PW, newPassword: 'brand new pw' }, { cookie: a });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true });
    expect((await sessionOf(t, a)).user?.username).toBe('pwuser');
    expect((await sessionOf(t, b)).user).toBeNull();
    expect((await login(t, 'pwuser', USER_PW)).res.statusCode).toBe(401);
    expect((await login(t, 'pwuser', 'brand new pw')).res.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------

describe('TOTP', () => {
  let t: TestApp;
  let cookie: string;
  let secret: string;
  beforeAll(async () => {
    t = await makeTestApp({ env: { SETUP_TOKEN } });
    await setupAdmin(t);
    writeSettings(t.db, { signupMode: 'open' });
    cookie = (await signup(t, 'twofa')).cookie!;
  });
  afterAll(async () => {
    await t.close();
  });

  it('setup returns a pending secret, otpauth URI and QR codes without enabling anything', async () => {
    const res = await post(t, API_ROUTES.me.totpSetup, undefined, { cookie });
    expect(res.statusCode).toBe(200);
    const body = res.json<TotpSetupResponse>();
    secret = body.secret;
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(body.otpauthUrl).toBe(
      `otpauth://totp/Outpost:twofa?secret=${secret}&issuer=Outpost&algorithm=SHA1&digits=6&period=30`,
    );
    expect(body.qrSvg).toMatch(/^<svg[\s\S]*<\/svg>\s*$/);
    expect(body.qrDataUrl).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/);
    expect(body.expiresAt).toBeGreaterThan(Date.now());
    expect((await sessionOf(t, cookie)).user?.totpEnabled).toBe(false);
    expect(t.db.value("SELECT totp_secret FROM users WHERE username = 'twofa'")).toBeNull();
  });

  it('enable refuses a wrong code and accepts a current one', async () => {
    const wrong = await post(t, API_ROUTES.me.totpEnable, { code: '000000' === totpCode(secret) ? '111111' : '000000' }, { cookie });
    expect(wrong.statusCode).toBe(403);
    const ok = await post(t, API_ROUTES.me.totpEnable, { code: totpCode(secret) }, { cookie });
    expect(ok.statusCode).toBe(200);
    expect((await sessionOf(t, cookie)).user?.totpEnabled).toBe(true);
    // A second setup while enabled is refused.
    expect((await post(t, API_ROUTES.me.totpSetup, undefined, { cookie })).statusCode).toBe(409);
    expect((await post(t, API_ROUTES.me.totpEnable, { code: totpCode(secret) }, { cookie })).statusCode).toBe(409);
  });

  it('login asks for the code, rejects bad or replayed codes and accepts a fresh one', async () => {
    const missing = await login(t, 'twofa', USER_PW);
    expect(missing.res.statusCode).toBe(401);
    expect(missing.res.json().error).toMatchObject({ code: 'totp_required', details: { reason: 'missing' } });
    expect(missing.cookie).toBeNull();

    const stale = await login(t, 'twofa', USER_PW, { totp: totpCode(secret, Date.now() - 5 * 60_000) });
    expect(stale.res.json().error).toMatchObject({ code: 'totp_required', details: { reason: 'invalid' } });

    // The enable call recorded its step: logging in with that same code is a replay.
    const used = t.db.value<number>("SELECT totp_last_step FROM users WHERE username = 'twofa'")!;
    const replay = await login(t, 'twofa', USER_PW, { totp: totpCode(secret, used * 30_000) });
    expect(replay.res.statusCode).toBe(401);
    expect(replay.res.json().error.details).toEqual({ reason: 'invalid' });

    const next = totpCode(secret, (used + 1) * 30_000);
    const ok = await login(t, 'twofa', USER_PW, { totp: `${next.slice(0, 3)} ${next.slice(3)}` });
    expect(ok.res.statusCode).toBe(200);
    expect(ok.res.json<LoginResponse>().user.totpEnabled).toBe(true);
    const again = await login(t, 'twofa', USER_PW, { totp: next });
    expect(again.res.statusCode).toBe(401);

    // A wrong password never reveals that TOTP is on.
    const wrongPw = await login(t, 'twofa', 'wrong password', { totp: next });
    expect(wrongPw.res.json().error.code).toBe('unauthorized');
  });

  it('disable needs the password or a current code', async () => {
    const none = await post(t, API_ROUTES.me.totpDisable, { password: '', code: '' }, { cookie });
    expect(none.statusCode).toBe(400);
    const bad = await post(t, API_ROUTES.me.totpDisable, { password: 'wrong password', code: '123456' }, { cookie });
    expect(bad.statusCode).toBe(403);
    const ok = await post(t, API_ROUTES.me.totpDisable, { password: USER_PW, code: '' }, { cookie });
    expect(ok.statusCode).toBe(200);
    expect((await sessionOf(t, cookie)).user?.totpEnabled).toBe(false);
    expect((await post(t, API_ROUTES.me.totpDisable, { password: USER_PW, code: '' }, { cookie })).statusCode).toBe(409);
    expect((await login(t, 'twofa', USER_PW)).res.statusCode).toBe(200);
  });

  it('disable with a code only; a re-enabled secret starts fresh', async () => {
    const s = (await post(t, API_ROUTES.me.totpSetup, undefined, { cookie })).json<TotpSetupResponse>().secret;
    expect(s).not.toBe(secret);
    expect((await post(t, API_ROUTES.me.totpEnable, { code: totpCode(s) }, { cookie })).statusCode).toBe(200);
    // The code used to enable cannot disable (replay); the next one can.
    const used = t.db.value<number>("SELECT totp_last_step FROM users WHERE username = 'twofa'")!;
    expect((await post(t, API_ROUTES.me.totpDisable, { password: '', code: totpCode(s, used * 30_000) }, { cookie })).statusCode).toBe(403);
    const next = totpCode(s, (used + 1) * 30_000);
    expect((await post(t, API_ROUTES.me.totpDisable, { password: '', code: next }, { cookie })).statusCode).toBe(200);
    expect(t.db.get("SELECT totp_secret, totp_last_step FROM users WHERE username = 'twofa'")).toEqual({
      totp_secret: null,
      totp_last_step: null,
    });
  });

  it('a pending secret expires', async () => {
    const s = (await post(t, API_ROUTES.me.totpSetup, undefined, { cookie })).json<TotpSetupResponse>().secret;
    t.db.run("UPDATE users SET totp_pending_at = 1 WHERE username = 'twofa'");
    const res = await post(t, API_ROUTES.me.totpEnable, { code: totpCode(s) }, { cookie });
    expect(res.statusCode).toBe(400);
    expect((await sessionOf(t, cookie)).user?.totpEnabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('CSRF / Origin and throttling', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await makeTestApp({ env: { SETUP_TOKEN } });
    await setupAdmin(t);
    writeSettings(t.db, { signupMode: 'open' });
    for (const u of ['victim', 'bystander', 'pwvictim', 'totpuser', 'totpvictim']) {
      expect((await signup(t, u)).res.statusCode).toBe(200);
    }
  });
  afterAll(async () => {
    await t.close();
  });

  it('refuses auth mutations without X-Outpost or from a foreign Origin', async () => {
    const body = { username: 'victim', password: USER_PW };
    for (const url of [API_ROUTES.login, API_ROUTES.signup, API_ROUTES.setup, API_ROUTES.logout, API_ROUTES.me.password]) {
      const noHeader = await t.app.inject({ method: 'POST', url, payload: body, headers: { origin: 'http://localhost:80', host: 'localhost:80' } });
      expect(noHeader.statusCode, url).toBe(403);
      expect(noHeader.json().error.code).toBe('csrf');
      const foreign = await t.app.inject({
        method: 'POST',
        url,
        payload: body,
        headers: { ...mutationHeaders, origin: 'https://evil.example' },
      });
      expect(foreign.statusCode, url).toBe(403);
      expect(foreign.json().error.code).toBe('csrf');
      const noOrigin = await t.app.inject({ method: 'POST', url, payload: body, headers: { 'x-outpost': '1', host: 'localhost:80' } });
      expect(noOrigin.statusCode, url).toBe(403);
    }
    // No session was created by any of them.
    expect(t.db.value('SELECT COUNT(*) FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = ?)', ['victim'])).toBe(1);
  });

  it('limits login requests per IP (429 with retry info)', async () => {
    const ip = nextIp();
    for (let i = 0; i < IP_LIMITS.login.max; i++) {
      expect((await login(t, 'nobody-here', 'whatever pw', { ip })).res.statusCode).toBe(401);
    }
    const res = (await login(t, 'bystander', USER_PW, { ip })).res;
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('rate_limited');
    expect(res.json().error.details.retryAfterSec).toBeGreaterThan(0);
    expect(res.json().error.details.retryAt).toBeGreaterThan(Date.now());
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    // Other IPs are unaffected.
    expect((await login(t, 'bystander', USER_PW)).res.statusCode).toBe(200);
  });

  it('limits failed logins per username across IPs, and leaves other accounts alone', async () => {
    for (let i = 0; i < FAILURE_LIMITS.account.max; i++) {
      expect((await login(t, 'victim', `wrong-${i}-password`)).res.statusCode).toBe(401);
    }
    // Even the right password is refused while the account is throttled.
    const blocked = (await login(t, 'VICTIM', USER_PW)).res;
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe('rate_limited');
    expect(blocked.json().error.details.retryAfterSec).toBeGreaterThan(0);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect((await login(t, 'bystander', USER_PW)).res.statusCode).toBe(200);
  });

  it('counts wrong current passwords against the account too', async () => {
    const { cookie } = await login(t, 'pwvictim', USER_PW);
    for (let i = 0; i < FAILURE_LIMITS.account.max; i++) {
      const r = await post(t, API_ROUTES.me.password, { currentPassword: `bad-${i}-pass`, newPassword: 'whatever new' }, { cookie });
      expect(r.statusCode).toBe(403);
    }
    const r = await post(t, API_ROUTES.me.password, { currentPassword: USER_PW, newPassword: 'whatever new' }, { cookie });
    expect(r.statusCode).toBe(429);
    expect((await login(t, 'pwvictim', USER_PW)).res.statusCode).toBe(429);
  });

  it('counts wrong TOTP codes at login against the account', async () => {
    const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
    t.db.run("UPDATE users SET totp_secret = ? WHERE username = 'totpvictim'", [secret]);
    for (let i = 0; i < FAILURE_LIMITS.account.max; i++) {
      const r = (await login(t, 'totpvictim', USER_PW, { totp: totpCode(secret, Date.now() - 10 * 60_000 - i * 30_000) })).res;
      expect(r.statusCode).toBe(401);
      expect(r.json().error.code).toBe('totp_required');
    }
    const r = (await login(t, 'totpvictim', USER_PW, { totp: totpCode(secret) })).res;
    expect(r.statusCode).toBe(429);
  });

  it('limits setup attempts per IP', async () => {
    const ip = nextIp();
    for (let i = 0; i < IP_LIMITS.setup.max; i++) {
      expect((await post(t, API_ROUTES.setup, { token: 'x', username: 'y', password: 'z' }, { ip })).statusCode).toBe(403);
    }
    expect((await post(t, API_ROUTES.setup, { token: 'x', username: 'y', password: 'z' }, { ip })).statusCode).toBe(429);
  });

  it('limits signups per IP', async () => {
    const ip = nextIp();
    for (let i = 0; i < IP_LIMITS.signup.max; i++) {
      expect((await post(t, API_ROUTES.signup, { username: 'x', password: 'y' }, { ip })).statusCode).toBe(400);
    }
    expect((await post(t, API_ROUTES.signup, { username: 'x', password: 'y' }, { ip })).statusCode).toBe(429);
  });

  it('limits TOTP endpoints per IP', async () => {
    const { cookie } = await login(t, 'totpuser', USER_PW);
    const ip = nextIp();
    for (let i = 0; i < IP_LIMITS.totp.max; i++) {
      expect((await post(t, API_ROUTES.me.totpEnable, { code: '123456' }, { cookie, ip })).statusCode).toBe(400);
    }
    expect((await post(t, API_ROUTES.me.totpEnable, { code: '123456' }, { cookie, ip })).statusCode).toBe(429);
  });
});
