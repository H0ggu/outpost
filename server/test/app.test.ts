import type { SessionInfo } from '@outpost/shared/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONTENT_SECURITY_POLICY } from '../src/http/security.ts';
import { createUserSession, makeTestApp, mutationHeaders, type TestApp } from './helpers.ts';

const expectSecurityHeaders = (headers: Record<string, unknown>): void => {
  expect(headers['content-security-policy']).toBe(CONTENT_SECURITY_POLICY);
  expect(headers['cross-origin-opener-policy']).toBe('same-origin');
  expect(headers['cross-origin-embedder-policy']).toBe('require-corp');
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['referrer-policy']).toBe('same-origin');
};

describe('app (no web build)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await makeTestApp();
  });
  afterAll(async () => {
    await t.close();
  });

  it('GET /api/health returns ok', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', version: t.config.version });
  });

  it('sends the security headers on success, 404 and errors', async () => {
    expectSecurityHeaders((await t.app.inject({ url: '/api/health' })).headers);
    const missing = await t.app.inject({ url: '/api/does-not-exist' });
    expect(missing.statusCode).toBe(404);
    expectSecurityHeaders(missing.headers);
    const csrf = await t.app.inject({ method: 'POST', url: '/api/logout' });
    expect(csrf.statusCode).toBe(403);
    expectSecurityHeaders(csrf.headers);
  });

  it('CSP matches PLAN §10 exactly', () => {
    expect(CONTENT_SECURITY_POLICY).toBe(
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; img-src 'self' data: blob:; " +
        "style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'",
    );
  });

  it('answers unknown API routes with the uniform error body', async () => {
    const res = await t.app.inject({ url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'not_found', message: 'No route for GET /api/nope' } });
  });

  it('rejects a POST without X-Outpost', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/logout', headers: { origin: 'http://localhost:80' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('csrf');
  });

  it('rejects a POST from a foreign or missing Origin', async () => {
    const foreign = await t.app.inject({
      method: 'POST',
      url: '/api/logout',
      headers: { 'x-outpost': '1', origin: 'https://evil.example', host: 'localhost:80' },
    });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json().error.code).toBe('csrf');
    const none = await t.app.inject({ method: 'DELETE', url: '/api/files/1', headers: { 'x-outpost': '1' } });
    expect(none.statusCode).toBe(403);
  });

  it('lets a same-host POST with the header through the CSRF check (dev/test)', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/logout', headers: mutationHeaders });
    expect(res.statusCode).toBe(404); // not implemented yet, but past the CSRF check
    expect(res.json().error.code).toBe('not_found');
  });

  it('GET /api/session reports setup required with no admin', async () => {
    const res = await t.app.inject({ url: '/api/session' });
    expect(res.statusCode).toBe(200);
    const body = res.json<SessionInfo>();
    expect(body).toMatchObject({ user: null, setupRequired: true, signupMode: 'closed', anonymousBrowsing: false });
  });

  it('resolves a session cookie to the user', async () => {
    const { cookie } = createUserSession(t.db, { username: 'Alice', role: 'admin' });
    const res = await t.app.inject({ url: '/api/session', headers: { cookie } });
    const body = res.json<SessionInfo>();
    expect(body.setupRequired).toBe(false);
    expect(body.user).toMatchObject({ username: 'Alice', role: 'admin', totpEnabled: false });
    expect(body.user?.prefs.theme).toBe('black');
  });

  it('keeps setup closed while any admin row exists, even a disabled one', async () => {
    const t2 = await makeTestApp();
    try {
      createUserSession(t2.db, { username: 'gone', role: 'admin', disabled: true });
      expect((await t2.app.inject({ url: '/api/session' })).json<SessionInfo>().setupRequired).toBe(false);
    } finally {
      await t2.close();
    }
  });

  it('ignores sessions of disabled users and unknown cookies', async () => {
    const { cookie } = createUserSession(t.db, { username: 'bob', disabled: true });
    expect((await t.app.inject({ url: '/api/session', headers: { cookie } })).json<SessionInfo>().user).toBeNull();
    const bogus = await t.app.inject({ url: '/api/session', headers: { cookie: 'outpost_session=nope' } });
    expect(bogus.json<SessionInfo>().user).toBeNull();
  });

  it('serves no SPA without a web build', async () => {
    const res = await t.app.inject({ url: '/u/someone' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
  });
});

describe('app with PUBLIC_ORIGIN', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await makeTestApp({ env: { PUBLIC_ORIGIN: 'https://chess.example.com' } });
  });
  afterAll(async () => {
    await t.close();
  });

  it('accepts the configured origin', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/logout',
      headers: { 'x-outpost': '1', origin: 'https://chess.example.com', host: 'internal:8080' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('marks cookies secure for an https origin', () => {
    expect(t.config.secureCookies).toBe(true);
  });
});

describe('app serving a web build', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await makeTestApp({ webDist: true });
  });
  afterAll(async () => {
    await t.close();
  });

  it('falls back to index.html for client routes', async () => {
    for (const url of ['/', '/u/magnus/games?color=white', '/admin/users']) {
      const res = await t.app.inject({ url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.headers['cache-control']).toBe('no-cache');
      expect(res.body).toContain('<div id="root">');
      expectSecurityHeaders(res.headers);
    }
  });

  it('serves studio.html at /studio', async () => {
    const res = await t.app.inject({ url: '/studio?game=1' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('analyse');
  });

  it('serves hashed assets as immutable and 404s missing ones as JSON', async () => {
    const ok = await t.app.inject({ url: '/assets/app-abc123.js' });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['cache-control']).toContain('immutable');
    expectSecurityHeaders(ok.headers);
    const missing = await t.app.inject({ url: '/assets/missing.js' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('not_found');
    const api = await t.app.inject({ url: '/api/nope' });
    expect(api.statusCode).toBe(404);
    expect(api.headers['content-type']).toContain('application/json');
  });
});
