/** `precheck` (src/app/api/hooks.ts): what the session already says is not asked of the server. */
import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PREFS, type SessionInfo, type SessionUser } from '@outpost/shared/api';
import { ApiError } from '../src/app/api/client.ts';
import { precheck, queryKeys } from '../src/app/api/hooks.ts';

const session = (over: Partial<SessionInfo> = {}): SessionInfo => ({
  user: null,
  setupRequired: false,
  signupMode: 'closed',
  anonymousBrowsing: false,
  hasLichessToken: false,
  version: '0.1.0',
  ...over,
});
const USER: SessionUser = { id: 1, username: 'alice', role: 'user', totpEnabled: false, prefs: { ...DEFAULT_PREFS } };

function serve(body: SessionInfo) {
  const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

afterEach(() => vi.unstubAllGlobals());

describe('precheck', () => {
  it('answers 401 for anonymous visitors without browsing, and 503 no_token without a token', async () => {
    const qc = new QueryClient();
    qc.setQueryData(queryKeys.session, session());
    const fetch = serve(session());
    await expect(precheck(qc, { audience: 'viewer' })).rejects.toMatchObject({ status: 401 });
    qc.setQueryData(queryKeys.session, session({ anonymousBrowsing: true }));
    await expect(precheck(qc, { audience: 'viewer' })).resolves.toBeUndefined();
    await expect(precheck(qc, { audience: 'user' })).rejects.toBeInstanceOf(ApiError);
    const noToken = await precheck(qc, { audience: 'viewer', lichessToken: true }).catch((e: unknown) => e);
    expect(noToken).toMatchObject({ status: 503, code: 'upstream_unavailable', details: { reason: 'no_token' } });
    expect(fetch).not.toHaveBeenCalled(); // fresh session: no request at all
  });

  it('reads the session first when nothing is cached', async () => {
    const qc = new QueryClient();
    const fetch = serve(session({ user: USER, hasLichessToken: true }));
    await expect(precheck(qc, { audience: 'user', lichessToken: true })).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('checks an old "no" again before believing it (signed in elsewhere since)', async () => {
    const qc = new QueryClient();
    qc.setQueryData(queryKeys.session, session(), { updatedAt: Date.now() - 60_000 });
    const fetch = serve(session({ user: USER }));
    await expect(precheck(qc, { audience: 'user' })).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('lets the server decide when the session cannot be read', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    await expect(precheck(qc, { audience: 'user' })).resolves.toBeUndefined();
  });
});
