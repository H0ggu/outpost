import type { LightMyRequestResponse } from 'fastify';
import {
  API_ROUTES,
  type AdminSettings,
  type AdminStatus,
  type AdminUser,
  type AdminUsersResponse,
  type Invite,
  type InvitesResponse,
  type SessionInfo,
} from '@outpost/shared/api';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/auth/password.ts';
import { STATUS_CACHE_MS } from '../src/auth/status.ts';
import { insertGame } from '../src/chess/store.ts';
import { readSettings } from '../src/settings.ts';
import { createSource, createUserSession, makeTestApp, mutationHeaders, testGame, type TestApp } from './helpers.ts';

const PW = 'a good password';

let ipSeq = 0;
const nextIp = (): string => `10.2.${++ipSeq >> 8}.${ipSeq & 255}`;

const req = (
  t: TestApp,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  cookie: string | null,
  payload?: object,
): Promise<LightMyRequestResponse> =>
  t.app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload }),
    headers: { ...(method === 'GET' ? {} : mutationHeaders), ...(cookie ? { cookie } : {}) },
    remoteAddress: nextIp(),
  });

/** A user with a real password (so they can sign in) and a live session. */
async function makeUser(t: TestApp, username: string, role: 'admin' | 'user' = 'user'): Promise<{ id: number; cookie: string }> {
  const { userId, cookie } = createUserSession(t.db, { username, role });
  t.db.run('UPDATE users SET password_hash = ? WHERE id = ?', [await hashPassword(PW), userId]);
  return { id: userId, cookie };
}

const login = (t: TestApp, username: string, password = PW) =>
  t.app.inject({ method: 'POST', url: API_ROUTES.login, payload: { username, password }, headers: mutationHeaders, remoteAddress: nextIp() });

const sessionUser = async (t: TestApp, cookie: string) =>
  (await t.app.inject({ url: API_ROUTES.session, headers: { cookie } })).json<SessionInfo>().user;

// ---------------------------------------------------------------------------

describe('admin access control', () => {
  let t: TestApp;
  let user: string;
  let admin: string;
  beforeAll(async () => {
    t = await makeTestApp();
    admin = (await makeUser(t, 'root', 'admin')).cookie;
    user = (await makeUser(t, 'pleb')).cookie;
  });
  afterAll(async () => {
    await t.close();
  });

  const endpoints: Array<['GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', string, object?]> = [
    ['GET', API_ROUTES.admin.settings],
    ['PUT', API_ROUTES.admin.settings, { signupMode: 'open' }],
    ['GET', API_ROUTES.admin.users],
    ['PATCH', API_ROUTES.admin.user(1), { role: 'user' }],
    ['DELETE', API_ROUTES.admin.user(1)],
    ['GET', API_ROUTES.admin.invites],
    ['POST', API_ROUTES.admin.invites, {}],
    ['DELETE', API_ROUTES.admin.invite('abc')],
    ['GET', API_ROUTES.admin.status],
  ];

  it('answers 401 to anonymous visitors and 403 to non-admins', async () => {
    for (const [method, url, body] of endpoints) {
      const anon = await req(t, method, url, null, body);
      expect(anon.statusCode, `${method} ${url}`).toBe(401);
      expect(anon.json().error.code).toBe('unauthorized');
      const pleb = await req(t, method, url, user, body);
      expect(pleb.statusCode, `${method} ${url}`).toBe(403);
      expect(pleb.json().error.code).toBe('forbidden');
    }
    expect(readSettings(t.db, t.config).signupMode).toBe('closed');
  });

  it('refuses admin mutations without the CSRF header or from a foreign Origin', async () => {
    for (const [method, url, body] of endpoints.filter(([m]) => m !== 'GET')) {
      const noHeader = await t.app.inject({
        method,
        url,
        ...(body ? { payload: body } : {}),
        headers: { cookie: admin, origin: 'http://localhost:80', host: 'localhost:80' },
      });
      expect(noHeader.statusCode).toBe(403);
      expect(noHeader.json().error.code).toBe('csrf');
      const foreign = await t.app.inject({
        method,
        url,
        ...(body ? { payload: body } : {}),
        headers: { ...mutationHeaders, origin: 'http://attacker.example', cookie: admin },
      });
      expect(foreign.json().error.code).toBe('csrf');
    }
    expect(readSettings(t.db, t.config).signupMode).toBe('closed');
    expect(t.db.value('SELECT COUNT(*) FROM users')).toBe(2);
  });
});

// ---------------------------------------------------------------------------

describe('admin settings', () => {
  let t: TestApp;
  let admin: string;
  beforeAll(async () => {
    t = await makeTestApp();
    admin = (await makeUser(t, 'root', 'admin')).cookie;
  });
  afterAll(async () => {
    await t.close();
  });

  const put = (body: object) => req(t, 'PUT', API_ROUTES.admin.settings, admin, body);

  it('GET returns the defaults', async () => {
    const res = await req(t, 'GET', API_ROUTES.admin.settings, admin);
    expect(res.statusCode).toBe(200);
    expect(res.json<AdminSettings>()).toEqual({
      signupMode: 'closed',
      anonymousBrowsing: false,
      lichessToken: { set: false, masked: null, fromEnv: false },
      chesscomContact: null,
      chesscomContactFromEnv: false,
      autoRefreshHourUtc: 9,
      updateCooldownMinutes: 15,
      initialSyncMonths: 0,
      mastersSource: 'lichess',
    });
  });

  it('PUT applies a subset and returns the full settings', async () => {
    const res = await put({ signupMode: 'invite', anonymousBrowsing: true, autoRefreshHourUtc: 3, updateCooldownMinutes: 0, initialSyncMonths: 12 });
    expect(res.statusCode).toBe(200);
    expect(res.json<AdminSettings>()).toMatchObject({
      signupMode: 'invite',
      anonymousBrowsing: true,
      autoRefreshHourUtc: 3,
      updateCooldownMinutes: 0,
      initialSyncMonths: 12,
      mastersSource: 'lichess',
    });
    const info = (await t.app.inject({ url: API_ROUTES.session })).json<SessionInfo>();
    expect(info).toMatchObject({ signupMode: 'invite', anonymousBrowsing: true });
    expect((await put({})).statusCode).toBe(200);
  });

  it('keeps the Lichess token write-only and masked', async () => {
    const token = 'lip_SecretTokenValue0123456789wxyz';
    const res = await put({ lichessToken: token });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('SecretTokenValue');
    expect(res.json<AdminSettings>().lichessToken).toEqual({ set: true, masked: 'lip_…wxyz', fromEnv: false });
    const got = await req(t, 'GET', API_ROUTES.admin.settings, admin);
    expect(got.body).not.toContain('SecretTokenValue');
    expect(readSettings(t.db, t.config).lichessToken).toBe(token);
    // Other changes leave it alone; null and "" clear it.
    expect((await put({ signupMode: 'open' })).json<AdminSettings>().lichessToken.set).toBe(true);
    expect((await put({ lichessToken: null })).json<AdminSettings>().lichessToken).toEqual({ set: false, masked: null, fromEnv: false });
    await put({ lichessToken: token });
    expect((await put({ lichessToken: '  ' })).json<AdminSettings>().lichessToken.set).toBe(false);
  });

  it('sets and clears the Chess.com contact', async () => {
    expect((await put({ chesscomContact: '  admin@example.com ' })).json<AdminSettings>().chesscomContact).toBe('admin@example.com');
    expect((await put({ chesscomContact: '' })).json<AdminSettings>().chesscomContact).toBeNull();
    expect((await put({ chesscomContact: 'someone' })).json<AdminSettings>().chesscomContact).toBe('someone');
    expect((await put({ chesscomContact: null })).json<AdminSettings>().chesscomContact).toBeNull();
  });

  it('validates every field and refuses unknown keys', async () => {
    const bad: object[] = [
      { signupMode: 'everyone' },
      { anonymousBrowsing: 'yes' },
      { lichessToken: 'has spaces in it' },
      { lichessToken: 'x'.repeat(3000) },
      { chesscomContact: 'line\r\nX-Injected: 1' },
      { chesscomContact: 'x'.repeat(201) },
      { chesscomContact: 'ünïcode' },
      { autoRefreshHourUtc: 24 },
      { autoRefreshHourUtc: 1.5 },
      { updateCooldownMinutes: -1 },
      { initialSyncMonths: 601 },
      { mastersSource: 'chessbase' },
      { mastersSource: 'reference:abc' },
      { mastersSource: 'reference:999' },
      { somethingElse: true },
    ];
    const before = (await req(t, 'GET', API_ROUTES.admin.settings, admin)).json<AdminSettings>();
    for (const body of bad) {
      const res = await put(body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json().error.code).toBe('validation');
    }
    expect((await req(t, 'GET', API_ROUTES.admin.settings, admin)).json<AdminSettings>()).toEqual(before);
  });

  it('accepts a reference database as the masters source', async () => {
    const id = t.db.run("INSERT INTO databases (owner_user_id, name, kind, created_at) VALUES (NULL, 'Broadcasts', 'reference', ?)", [
      Date.now(),
    ]).lastInsertRowid;
    const games = t.db.run("INSERT INTO databases (owner_user_id, name, kind, created_at) VALUES (NULL, 'Mine', 'games', ?)", [
      Date.now(),
    ]).lastInsertRowid;
    expect((await put({ mastersSource: `reference:${games}` })).statusCode).toBe(400);
    const res = await put({ mastersSource: `reference:${id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json<AdminSettings>().mastersSource).toBe(`reference:${id}`);
    expect((await put({ mastersSource: 'lichess' })).json<AdminSettings>().mastersSource).toBe('lichess');
  });
});

describe('admin settings with env overrides', () => {
  let t: TestApp;
  let admin: string;
  beforeAll(async () => {
    t = await makeTestApp({ env: { LICHESS_TOKEN: 'lip_EnvToken000000000000abcd', CHESSCOM_CONTACT: 'ops@example.org' } });
    admin = (await makeUser(t, 'root', 'admin')).cookie;
  });
  afterAll(async () => {
    await t.close();
  });

  it('shows env values as winning, masked, and keeps a UI value underneath', async () => {
    const res = await req(t, 'GET', API_ROUTES.admin.settings, admin);
    expect(res.body).not.toContain('EnvToken');
    expect(res.json<AdminSettings>()).toMatchObject({
      lichessToken: { set: true, masked: 'lip_…abcd', fromEnv: true },
      chesscomContact: 'ops@example.org',
      chesscomContactFromEnv: true,
    });
    const put = await req(t, 'PUT', API_ROUTES.admin.settings, admin, { lichessToken: 'lip_UiToken0000000000000zzzz', chesscomContact: 'ui@example.org' });
    expect(put.statusCode).toBe(200);
    expect(put.json<AdminSettings>()).toMatchObject({
      lichessToken: { set: true, masked: 'lip_…abcd', fromEnv: true },
      chesscomContact: 'ops@example.org',
    });
    expect(t.db.value("SELECT value FROM instance_settings WHERE key = 'chesscomContact'")).toBe('"ui@example.org"');
  });
});

// ---------------------------------------------------------------------------

describe('admin users', () => {
  let t: TestApp;
  let root: { id: number; cookie: string };
  beforeEach(async () => {
    t = await makeTestApp();
    root = await makeUser(t, 'root', 'admin');
  });
  afterEach(async () => {
    await t.close();
  });

  const patch = (cookie: string, id: number | string, body: object) => req(t, 'PATCH', API_ROUTES.admin.user(id), cookie, body);
  const del = (cookie: string, id: number | string) => req(t, 'DELETE', API_ROUTES.admin.user(id), cookie);

  it('lists users with profile counts and last activity', async () => {
    const bob = await makeUser(t, 'bob');
    t.db.run("UPDATE sessions SET last_seen_at = 1234 WHERE user_id = ?", [bob.id]);
    t.db.run("INSERT INTO profiles (slug, display_name, owner_user_id, created_at, updated_at) VALUES ('bob-p', 'P', ?, 1, 1)", [bob.id]);
    t.db.run('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)', ['ghost', 'x', 5]);
    const res = await req(t, 'GET', API_ROUTES.admin.users, root.cookie);
    expect(res.statusCode).toBe(200);
    const users = res.json<AdminUsersResponse>().users;
    expect(users.map(u => u.username)).toEqual(['root', 'bob', 'ghost']);
    expect(users[1]).toEqual<AdminUser>({
      id: bob.id,
      username: 'bob',
      role: 'user',
      disabled: false,
      totpEnabled: false,
      createdAt: expect.any(Number) as number,
      lastSeenAt: 1234,
      profileCount: 1,
    });
    expect(users[2]).toMatchObject({ lastSeenAt: null, profileCount: 0, createdAt: 5 });
  });

  it('promotes and demotes; never demotes or disables the last active admin', async () => {
    const bob = await makeUser(t, 'bob');
    const lastAdmin = await patch(root.cookie, root.id, { role: 'user' });
    expect(lastAdmin.statusCode).toBe(409);
    expect(lastAdmin.json().error).toMatchObject({ code: 'conflict', details: { reason: 'last_admin' } });
    expect((await patch(root.cookie, root.id, { disabled: true })).statusCode).toBe(403);

    const promoted = await patch(root.cookie, bob.id, { role: 'admin' });
    expect(promoted.statusCode).toBe(200);
    expect(promoted.json<AdminUser>()).toMatchObject({ id: bob.id, role: 'admin', disabled: false });
    expect((await sessionUser(t, bob.cookie))?.role).toBe('admin');

    // Two active admins: bob may be disabled, leaving root as the last active one.
    expect((await patch(root.cookie, bob.id, { disabled: true })).json<AdminUser>()).toMatchObject({ role: 'admin', disabled: true });
    expect((await patch(root.cookie, root.id, { role: 'user' })).statusCode).toBe(409);
    // A disabled admin can be demoted freely; setup stays closed regardless.
    expect((await patch(root.cookie, bob.id, { role: 'user' })).statusCode).toBe(200);

    // With bob re-enabled and promoted, root may step down (and loses admin access).
    await patch(root.cookie, bob.id, { disabled: false, role: 'admin' });
    const stepDown = await patch(root.cookie, root.id, { role: 'user' });
    expect(stepDown.statusCode).toBe(200);
    expect((await req(t, 'GET', API_ROUTES.admin.users, root.cookie)).statusCode).toBe(403);
    // Disabling bob earlier signed him out; he signs in again and is now the last active admin.
    expect(await sessionUser(t, bob.cookie)).toBeNull();
    const bobLogin = await login(t, 'bob');
    const bobCookie = `outpost_session=${bobLogin.cookies.find(c => c.name === 'outpost_session')!.value}`;
    expect((await patch(bobCookie, bob.id, { role: 'user' })).statusCode).toBe(409);
  });

  it('disabling signs the user out everywhere and blocks login; re-enabling restores it', async () => {
    const bob = await makeUser(t, 'bob');
    expect((await login(t, 'bob')).statusCode).toBe(200);
    expect(t.db.value('SELECT COUNT(*) FROM sessions WHERE user_id = ?', [bob.id])).toBe(2);
    const res = await patch(root.cookie, bob.id, { disabled: true });
    expect(res.json<AdminUser>().disabled).toBe(true);
    expect(t.db.value('SELECT COUNT(*) FROM sessions WHERE user_id = ?', [bob.id])).toBe(0);
    expect(await sessionUser(t, bob.cookie)).toBeNull();
    expect((await login(t, 'bob')).statusCode).toBe(403);
    expect((await patch(root.cookie, bob.id, { disabled: false })).json<AdminUser>().disabled).toBe(false);
    expect((await login(t, 'bob')).statusCode).toBe(200);
  });

  it('resets a password (signing the user out) and TOTP', async () => {
    const bob = await makeUser(t, 'bob');
    t.db.run('UPDATE users SET totp_secret = ?, totp_last_step = 5 WHERE id = ?', ['JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', bob.id]);
    expect((await patch(root.cookie, bob.id, { password: 'short' })).statusCode).toBe(400);
    const res = await patch(root.cookie, bob.id, { password: 'a brand new one', resetTotp: true });
    expect(res.statusCode).toBe(200);
    expect(res.json<AdminUser>()).toMatchObject({ totpEnabled: false });
    expect(await sessionUser(t, bob.cookie)).toBeNull();
    expect((await login(t, 'bob')).statusCode).toBe(401);
    expect((await login(t, 'bob', 'a brand new one')).statusCode).toBe(200);
    expect(t.db.get('SELECT totp_secret, totp_last_step FROM users WHERE id = ?', [bob.id])).toEqual({ totp_secret: null, totp_last_step: null });
  });

  it("an admin resetting their own password keeps the current session only", async () => {
    expect((await login(t, 'root')).statusCode).toBe(200);
    expect(t.db.value('SELECT COUNT(*) FROM sessions WHERE user_id = ?', [root.id])).toBe(2);
    const res = await patch(root.cookie, root.id, { password: 'my own new one' });
    expect(res.statusCode).toBe(200);
    expect(t.db.value('SELECT COUNT(*) FROM sessions WHERE user_id = ?', [root.id])).toBe(1);
    expect((await sessionUser(t, root.cookie))?.username).toBe('root');
    expect((await login(t, 'root', 'my own new one')).statusCode).toBe(200);
  });

  it('validates the id and body; 404 for unknown users', async () => {
    expect((await patch(root.cookie, 999, { role: 'admin' })).statusCode).toBe(404);
    expect((await patch(root.cookie, 'abc', { role: 'admin' })).statusCode).toBe(400);
    expect((await patch(root.cookie, root.id, { role: 'owner' })).statusCode).toBe(400);
    expect((await patch(root.cookie, root.id, { username: 'renamed' })).statusCode).toBe(400);
    expect((await del(root.cookie, 999)).statusCode).toBe(404);
    expect((await del(root.cookie, 0)).statusCode).toBe(400);
  });

  it('never deletes yourself', async () => {
    const res = await del(root.cookie, root.id);
    expect(res.statusCode).toBe(403);
    expect(t.db.value('SELECT COUNT(*) FROM users WHERE id = ?', [root.id])).toBe(1);
  });

  it('deletes a user with their own data, keeps shared data', async () => {
    const bob = await makeUser(t, 'bob');
    const carol = await makeUser(t, 'carol');
    const now = Date.now();
    // bob's profile (bookmarked by carol), with a Lichess source shared with carol's profile.
    const src = createSource(t.db, { kind: 'lichess', key: 'somebody' });
    insertGame(t.db, testGame({ white: { name: 'somebody' } }));
    const bobProfile = t.db.run("INSERT INTO profiles (slug, display_name, owner_user_id, visibility, created_at, updated_at) VALUES ('bobs', 'Bobs', ?, 'public', ?, ?)", [bob.id, now, now]).lastInsertRowid;
    const carolProfile = t.db.run("INSERT INTO profiles (slug, display_name, owner_user_id, created_at, updated_at) VALUES ('carols', 'Carols', ?, ?, ?)", [carol.id, now, now]).lastInsertRowid;
    t.db.run('INSERT INTO profile_sources (profile_id, source_id) VALUES (?, ?), (?, ?)', [bobProfile, src, carolProfile, src]);
    t.db.run('INSERT INTO bookmarks (user_id, profile_id, created_at) VALUES (?, ?, ?)', [carol.id, bobProfile, now]);
    // bob's games database with a game, his reference database, a file and a prep set.
    const gamesDb = t.db.run("INSERT INTO databases (owner_user_id, name, kind, created_at) VALUES (?, 'Mine', 'games', ?)", [bob.id, now]).lastInsertRowid;
    insertGame(t.db, testGame({ origin: 'pgn', originId: `${gamesDb}:abc`, databaseId: gamesDb }));
    const refDb = t.db.run("INSERT INTO databases (owner_user_id, name, kind, visibility, created_at) VALUES (?, 'OTB', 'reference', 'public', ?)", [bob.id, now]).lastInsertRowid;
    t.db.run("INSERT INTO files (owner_user_id, name, kind, pgn, created_at, updated_at) VALUES (?, 'rep', 'repertoire', '*', ?, ?)", [bob.id, now, now]);
    const prep = t.db.run("INSERT INTO prep_sets (owner_user_id, name, created_at, updated_at) VALUES (?, 'Open', ?, ?)", [bob.id, now, now]).lastInsertRowid;
    t.db.run('INSERT INTO prep_opponents (prep_id, profile_id) VALUES (?, ?)', [prep, carolProfile]);
    // bob used an invite, created another and queued a job.
    t.db.run("INSERT INTO invites (code, created_by, created_at, used_by, used_at) VALUES ('used1', ?, ?, ?, ?)", [root.id, now, bob.id, now]);
    t.db.run("INSERT INTO invites (code, created_by, created_at) VALUES ('bobs1', ?, ?)", [bob.id, now]);
    const job = t.db.run("INSERT INTO jobs (kind, lane, user_id, created_at) VALUES ('sync', 'lichess', ?, ?)", [bob.id, now]).lastInsertRowid;

    const res = await del(root.cookie, bob.id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    const count = (sql: string, p: Array<number | string> = []) => t.db.value<number>(sql, p);
    expect(count('SELECT COUNT(*) FROM users WHERE id = ?', [bob.id])).toBe(0);
    expect(count('SELECT COUNT(*) FROM sessions WHERE user_id = ?', [bob.id])).toBe(0);
    expect(await sessionUser(t, bob.cookie)).toBeNull();
    // Owned data is gone…
    expect(count('SELECT COUNT(*) FROM profiles WHERE id = ?', [bobProfile])).toBe(0);
    expect(count('SELECT COUNT(*) FROM bookmarks WHERE profile_id = ?', [bobProfile])).toBe(0);
    expect(count('SELECT COUNT(*) FROM databases WHERE id = ?', [gamesDb])).toBe(0);
    expect(count('SELECT COUNT(*) FROM games WHERE database_id = ?', [gamesDb])).toBe(0);
    expect(count('SELECT COUNT(*) FROM files WHERE owner_user_id = ?', [bob.id])).toBe(0);
    expect(count('SELECT COUNT(*) FROM prep_sets WHERE id = ?', [prep])).toBe(0);
    // …shared data stays.
    expect(t.db.get('SELECT owner_user_id FROM databases WHERE id = ?', [refDb])).toEqual({ owner_user_id: null });
    expect(count('SELECT COUNT(*) FROM sources WHERE id = ?', [src])).toBe(1);
    expect(count("SELECT COUNT(*) FROM games WHERE origin = 'lichess'")).toBe(1);
    expect(count('SELECT COUNT(*) FROM profiles WHERE id = ?', [carolProfile])).toBe(1);
    expect(count('SELECT COUNT(*) FROM profile_sources WHERE profile_id = ?', [carolProfile])).toBe(1);
    expect(t.db.get("SELECT used_by, used_at IS NOT NULL AS used FROM invites WHERE code = 'used1'")).toEqual({ used_by: null, used: 1 });
    expect(t.db.get("SELECT created_by FROM invites WHERE code = 'bobs1'")).toEqual({ created_by: null });
    expect(t.db.get('SELECT user_id FROM jobs WHERE id = ?', [job])).toEqual({ user_id: null });
    expect(await sessionUser(t, carol.cookie)).toMatchObject({ username: 'carol' });
    // A used invite stays used: nobody can sign up with it.
    t.db.run("INSERT INTO instance_settings (key, value) VALUES ('signupMode', '\"invite\"')");
    const signup = await t.app.inject({
      method: 'POST',
      url: API_ROUTES.signup,
      payload: { username: 'newbob', password: PW, invite: 'used1' },
      headers: mutationHeaders,
      remoteAddress: nextIp(),
    });
    expect(signup.statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------

describe('admin invites', () => {
  let t: TestApp;
  let admin: string;
  beforeAll(async () => {
    t = await makeTestApp();
    admin = (await makeUser(t, 'root', 'admin')).cookie;
  });
  afterAll(async () => {
    await t.close();
  });

  it('creates codes with and without expiry', async () => {
    const forever = await req(t, 'POST', API_ROUTES.admin.invites, admin, {});
    expect(forever.statusCode).toBe(200);
    const inv = forever.json<Invite>();
    expect(inv.code).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(inv).toMatchObject({ expiresAt: null, usedBy: null, usedAt: null, createdBy: { username: 'root' } });

    const week = (await req(t, 'POST', API_ROUTES.admin.invites, admin, { expiresInDays: 7 })).json<Invite>();
    expect(week.expiresAt! - week.createdAt).toBe(7 * 24 * 3600 * 1000);
    expect(week.code).not.toBe(inv.code);

    // No body at all is fine too.
    expect((await t.app.inject({ method: 'POST', url: API_ROUTES.admin.invites, headers: { ...mutationHeaders, cookie: admin } })).statusCode).toBe(200);
  });

  it('validates the expiry', async () => {
    for (const body of [{ expiresInDays: 0 }, { expiresInDays: 366 }, { expiresInDays: 1.5 }, { expiresInDays: '7' }, { code: 'mine' }]) {
      expect((await req(t, 'POST', API_ROUTES.admin.invites, admin, body)).statusCode, JSON.stringify(body)).toBe(400);
    }
  });

  it('lists invites newest first and shows who used them', async () => {
    t.db.run("INSERT INTO instance_settings (key, value) VALUES ('signupMode', '\"invite\"') ON CONFLICT (key) DO UPDATE SET value = excluded.value");
    const inv = (await req(t, 'POST', API_ROUTES.admin.invites, admin, { expiresInDays: 1 })).json<Invite>();
    const signup = await t.app.inject({
      method: 'POST',
      url: API_ROUTES.signup,
      payload: { username: 'newcomer', password: PW, invite: inv.code },
      headers: mutationHeaders,
      remoteAddress: nextIp(),
    });
    expect(signup.statusCode).toBe(200);
    const list = (await req(t, 'GET', API_ROUTES.admin.invites, admin)).json<InvitesResponse>().invites;
    expect(list[0]!.code).toBe(inv.code);
    expect(list[0]!.usedBy).toEqual({ id: signup.json().user.id, username: 'newcomer' });
    expect(list[0]!.usedAt).toBeGreaterThan(0);
    const times = list.map(i => i.createdAt);
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it('deletes invites (404 when unknown, 400 for malformed codes)', async () => {
    const inv = (await req(t, 'POST', API_ROUTES.admin.invites, admin, {})).json<Invite>();
    expect((await req(t, 'DELETE', API_ROUTES.admin.invite(inv.code), admin)).json()).toEqual({ ok: true });
    expect((await req(t, 'DELETE', API_ROUTES.admin.invite(inv.code), admin)).statusCode).toBe(404);
    expect((await req(t, 'DELETE', API_ROUTES.admin.invite('bad code!'), admin)).statusCode).toBe(400);
    const list = (await req(t, 'GET', API_ROUTES.admin.invites, admin)).json<InvitesResponse>().invites;
    expect(list.some(i => i.code === inv.code)).toBe(false);
  });
});

// ---------------------------------------------------------------------------

interface FakeCall {
  url: string;
  method: string;
  authorization: string | null;
}
type Route = (url: URL) => Response | Promise<Response>;

/** A fake upstream: `routes` keyed by `host + pathname`; unknown URLs fail like a dead network. */
function fakeUpstream() {
  const calls: FakeCall[] = [];
  const routes = new Map<string, Route>();
  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init.headers);
    calls.push({ url: url.toString(), method: init.method ?? 'GET', authorization: headers.get('authorization') });
    const route = routes.get(`${url.host}${url.pathname}`);
    if (!route) throw new TypeError('fetch failed: getaddrinfo ENOTFOUND');
    return route(url);
  };
  const healthy = (): void => {
    routes.set('lichess.org/robots.txt', () => new Response('User-agent: *'));
    routes.set('explorer.lichess.org/masters', () => Response.json({ white: 1, draws: 1, black: 1, moves: [], topGames: [] }));
    routes.set('api.chess.com/pub/country/US', () => Response.json({ code: 'US', name: 'United States' }));
    routes.set('database.lichess.org/', () => new Response(null, { status: 200 }));
    routes.set('lichess.org/api/account', () =>
      Response.json({ id: 'outpost-bot', username: 'Outpost-Bot' }, { headers: { 'x-oauth-scopes': 'study:read, preference:read' } }),
    );
  };
  healthy();
  return { fetch, calls, routes, healthy };
}

describe('admin status', () => {
  const TOKEN = 'lip_StatusToken00000000000000';
  let t: TestApp;
  let admin: string;
  let up: ReturnType<typeof fakeUpstream>;
  beforeAll(async () => {
    up = fakeUpstream();
    t = await makeTestApp({ env: { LICHESS_TOKEN: TOKEN }, fetch: up.fetch });
    admin = (await makeUser(t, 'root', 'admin')).cookie;
  });
  afterAll(async () => {
    await t.close();
  });

  const status = async (refresh = false): Promise<AdminStatus> => {
    const res = await req(t, 'GET', `${API_ROUTES.admin.status}${refresh ? '?refresh=1' : ''}`, admin);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('StatusToken');
    return res.json<AdminStatus>();
  };

  it('reports versions, sizes, counts, the token and upstream reachability', async () => {
    insertGame(t.db, testGame());
    insertGame(t.db, testGame({ origin: 'reference', originId: 'ref:1' }));
    for (const s of ['queued', 'queued', 'running', 'error']) {
      t.db.run("INSERT INTO jobs (kind, lane, status, created_at) VALUES ('geo', 'lichess', ?, ?)", [s, Date.now()]);
    }
    const s = await status(true);
    expect(s.version).toBe(t.config.version);
    expect(s.nodeVersion).toBe(process.version);
    expect(s.sqliteVersion).toMatch(/^3\.\d+\.\d+/);
    expect(s.dataDir).toBe(t.config.dataDir);
    expect(s.dbSizeBytes).toBeGreaterThan(0);
    expect(s.uptimeSec).toBeGreaterThanOrEqual(0);
    expect(s.checkedAt).toBeGreaterThan(0);
    expect(s.lichessToken).toEqual({
      configured: true,
      valid: true,
      userId: 'outpost-bot',
      scopes: ['study:read', 'preference:read'],
      state: 'valid',
      error: null,
      fromEnv: true,
    });
    expect(s.upstream.map(u => u.name)).toEqual(['lichess', 'lichess-explorer', 'chesscom', 'lichess-database']);
    for (const u of s.upstream) {
      expect(u).toMatchObject({ ok: true, status: 200, error: null });
      expect(u.latencyMs).toBeGreaterThanOrEqual(0);
    }
    expect(s.counts).toEqual({ users: 1, profiles: 0, sources: 0, games: 1, referenceGames: 1, positions: 14, queuedJobs: 2 });
    expect(s.jobs).toEqual({ queued: 2, running: 1, done: 0, error: 1, cancelled: 0 });

    // The token goes only to Lichess hosts that need it: the account check and the explorer probe.
    const authed = up.calls.filter(c => c.authorization !== null);
    expect(authed.map(c => new URL(c.url).host).sort()).toEqual(['explorer.lichess.org', 'lichess.org']);
    expect(authed.every(c => c.authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(up.calls.find(c => c.url.startsWith('https://lichess.org/api/account'))).toBeTruthy();
    expect(up.calls.find(c => c.url.startsWith('https://database.lichess.org'))?.method).toBe('HEAD');
  });

  it('caches probes for about a minute; ?refresh=1 runs them again; job counts stay live', async () => {
    await status(true);
    const n = up.calls.length;
    t.db.run("INSERT INTO jobs (kind, lane, status, created_at) VALUES ('geo', 'lichess', 'queued', ?)", [Date.now()]);
    const cached = await status();
    expect(up.calls.length).toBe(n);
    expect(cached.counts.queuedJobs).toBe(3);
    expect(Date.now() - cached.checkedAt!).toBeLessThan(STATUS_CACHE_MS);
    await status(true);
    expect(up.calls.length).toBe(n + 5);
  });

  it('shares one probe run between concurrent requests', async () => {
    await status(true);
    const n = up.calls.length;
    const [a, b] = await Promise.all([
      req(t, 'GET', `${API_ROUTES.admin.status}?refresh=1`, admin),
      req(t, 'GET', API_ROUTES.admin.status, admin),
    ]);
    expect(a.json<AdminStatus>().checkedAt).toBe(b.json<AdminStatus>().checkedAt);
    expect(up.calls.length).toBe(n + 5);
  });

  it('reports a refused token as invalid and a failing Lichess as unknown', async () => {
    up.routes.set('lichess.org/api/account', () => Response.json({ error: 'No such token' }, { status: 401 }));
    expect((await status(true)).lichessToken).toMatchObject({ configured: true, valid: false, state: 'invalid', userId: null, scopes: [] });
    up.routes.set('lichess.org/api/account', () => new Response('oops', { status: 502 }));
    const s = await status(true);
    expect(s.lichessToken).toMatchObject({ configured: true, valid: null, state: 'unknown' });
    expect(s.lichessToken.error).toMatch(/502/);
    up.healthy();
  });

  it('reports unreachable hosts and HTTP errors per probe', async () => {
    up.routes.delete('database.lichess.org/');
    up.routes.set('api.chess.com/pub/country/US', () => Response.json({ message: 'blocked' }, { status: 403 }));
    const s = await status(true);
    const by = Object.fromEntries(s.upstream.map(u => [u.name, u]));
    expect(by['lichess-database']).toMatchObject({ ok: false, status: null, latencyMs: null });
    expect(by['lichess-database']!.error).toMatch(/Could not reach database\.lichess\.org/);
    expect(by.chesscom).toMatchObject({ ok: false, status: 403, error: 'HTTP 403' });
    expect(by.lichess).toMatchObject({ ok: true });
    up.healthy();
  });

  it('honours a 429 cool-down without contacting the host again', async () => {
    up.routes.set('api.chess.com/pub/country/US', () => new Response('slow down', { status: 429, headers: { 'retry-after': '120' } }));
    const first = await status(true);
    expect(first.upstream.find(u => u.name === 'chesscom')).toMatchObject({ ok: false, status: 429 });
    const n = up.calls.filter(c => c.url.includes('api.chess.com')).length;
    const second = await status(true);
    expect(second.upstream.find(u => u.name === 'chesscom')).toMatchObject({ ok: false, status: 429 });
    expect(second.upstream.find(u => u.name === 'chesscom')!.error).toMatch(/rate limiting/);
    expect(up.calls.filter(c => c.url.includes('api.chess.com')).length).toBe(n);
    up.healthy();
  });
});

describe('admin status without a token', () => {
  let t: TestApp;
  let admin: string;
  let up: ReturnType<typeof fakeUpstream>;
  beforeAll(async () => {
    up = fakeUpstream();
    t = await makeTestApp({ fetch: up.fetch });
    admin = (await makeUser(t, 'root', 'admin')).cookie;
  });
  afterAll(async () => {
    await t.close();
  });

  it("reports 'missing' without asking Lichess, then checks a token set in the UI right away", async () => {
    const s = (await req(t, 'GET', API_ROUTES.admin.status, admin)).json<AdminStatus>();
    expect(s.lichessToken).toEqual({ configured: false, valid: null, userId: null, scopes: [], state: 'missing', error: null, fromEnv: false });
    expect(up.calls.some(c => c.url.includes('/api/account'))).toBe(false);
    expect(up.calls.every(c => c.authorization === null)).toBe(true);

    // Setting a token invalidates the cached probes.
    expect((await req(t, 'PUT', API_ROUTES.admin.settings, admin, { lichessToken: 'lip_UiSetToken000000000000' })).statusCode).toBe(200);
    const after = (await req(t, 'GET', API_ROUTES.admin.status, admin)).json<AdminStatus>();
    expect(after.lichessToken).toMatchObject({ configured: true, valid: true, state: 'valid', fromEnv: false });
    expect(up.calls.filter(c => c.url.includes('/api/account'))).toHaveLength(1);
  });

  it('rejects a malformed refresh flag', async () => {
    expect((await req(t, 'GET', `${API_ROUTES.admin.status}?refresh=maybe`, admin)).statusCode).toBe(400);
  });
});
