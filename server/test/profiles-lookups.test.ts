import type { SearchResults } from '@outpost/shared/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccountLookups, accountLookups, LOOKUPS_PER_CLIENT_PER_MIN, MISSING_ACCOUNT_TTL_MS } from '../src/profiles/lookups.ts';
import { search, SearchCache } from '../src/search/index.ts';
import { createUserSession, makeTestApp, mutationHeaders, type TestApp } from './helpers.ts';
import { fakeUpstream, HIKARU_PLAYER, HIKARU_STATS, json, lichessUser } from './fixtures/profiles/upstream.ts';

describe('account lookup budgets', () => {
  it('caps the instance per site and each client within it, and remembers missing accounts', () => {
    let now = 0;
    const l = new AccountLookups({ now: () => now, perMin: { lichess: 3 }, perClient: 2 });
    expect([l.take('lichess', 'a'), l.take('lichess', 'a'), l.take('lichess', 'a')]).toEqual([true, true, false]);
    expect([l.take('lichess', 'b'), l.take('lichess', 'c')]).toEqual([true, false]); // instance budget spent
    expect(l.take('chesscom', 'a')).toBe(true); // another site, another budget
    now = 60_001;
    expect(l.take('lichess', 'a')).toBe(true);
    l.markMissing('lichess', 'ghost');
    expect(l.isMissing('lichess', 'ghost')).toBe(true);
    expect(l.isMissing('chesscom', 'ghost')).toBe(false);
    now += MISSING_ACCOUNT_TTL_MS + 1;
    expect(l.isMissing('lichess', 'ghost')).toBe(false);
  });
});

describe('search and account checks spend the lookup budget', () => {
  let t: TestApp;
  const up = fakeUpstream({
    'GET lichess.org/api/player/autocomplete': () => json({ result: [] }),
    'GET lichess.org/api/user/realone': () => json(lichessUser('RealOne')),
  });
  let cookie: string;
  beforeAll(async () => {
    t = await makeTestApp({ fetch: up.fetch });
    cookie = createUserSession(t.db, { username: 'searcher' }).cookie;
  });
  afterAll(async () => t.close());

  it("remembers that an account doesn't exist instead of asking again", async () => {
    const create = () =>
      t.app.inject({ method: 'POST', url: '/api/profiles', headers: { ...mutationHeaders, cookie }, payload: { displayName: 'X', sources: [{ kind: 'lichess', key: 'nobodyhere' }] } });
    expect((await create()).statusCode).toBe(400);
    const calls = up.calls.length;
    const again = await create();
    expect(again.statusCode).toBe(400);
    expect(again.json().error.message).toMatch(/No Lichess account/);
    expect(up.calls.length).toBe(calls);
  });

  it('reports a site unavailable to a client over its share, and refuses account checks with 503 busy', async () => {
    const lookups = accountLookups(t.app.upstream);
    const me = t.db.value<number>("SELECT id FROM users WHERE username = 'searcher'")!;
    while (lookups.take('lichess', `user:${me}`));
    const res = await t.app.inject({ url: '/api/search?q=somebodynew', headers: { cookie } });
    expect(res.json<SearchResults>().unavailable).toContain('lichess');
    const create = await t.app.inject({
      method: 'POST',
      url: '/api/profiles',
      headers: { ...mutationHeaders, cookie },
      payload: { displayName: 'Real', sources: [{ kind: 'lichess', key: 'realone' }] },
    });
    expect(create.statusCode).toBe(503);
    expect(create.json().error).toMatchObject({ code: 'upstream_unavailable', details: { reason: 'busy' } });
    // Another user still has a share (the instance budget is not spent yet).
    const other = createUserSession(t.db, { username: 'other' }).cookie;
    const ok = await t.app.inject({
      method: 'POST',
      url: '/api/profiles',
      headers: { ...mutationHeaders, cookie: other },
      payload: { displayName: 'Real', sources: [{ kind: 'lichess', key: 'realone' }] },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(LOOKUPS_PER_CLIENT_PER_MIN).toBeLessThan(60);
  });
});

describe("a search hit's follow-up lookups (ratings, last seen) spend the budget too", () => {
  let t: TestApp;
  const up = fakeUpstream({
    'GET lichess.org/api/player/autocomplete': () => json({ result: [{ id: 'hikaru', name: 'Hikaru' }] }),
    'GET api.chess.com/pub/player/hikaru': () => json(HIKARU_PLAYER),
    'GET api.chess.com/pub/player/hikaru/stats': () => json(HIKARU_STATS),
    'POST lichess.org/api/users': () => json([lichessUser('Hikaru', { blitz: 2900 })]),
  });
  beforeAll(async () => {
    t = await makeTestApp({ fetch: up.fetch });
  });
  afterAll(async () => t.close());

  it('leaves the facts out, never the site, when only the search itself fits', async () => {
    const lookups = accountLookups(t.app.upstream);
    const client = 'user:900';
    // One lookup left per site: the autocomplete and the exact-name check.
    for (let i = 0; i < LOOKUPS_PER_CLIENT_PER_MIN - 1; i++) {
      lookups.take('lichess', client);
      lookups.take('chesscom', client);
    }
    const tight = await search({ db: t.db, upstream: t.app.upstream, cache: new SearchCache(), client }, 'hikaru', null);
    expect(tight.unavailable).toBeUndefined();
    expect(tight.chesscom[0]).toMatchObject({ username: 'Hikaru', exists: true, country: 'US' });
    expect(tight.chesscom[0]!.ratings ?? []).toEqual([]);
    expect(tight.lichess[0]!.username).toBe('Hikaru');
    expect(tight.lichess[0]!.ratings).toBeUndefined();
    expect(up.calls).not.toContain('GET api.chess.com/pub/player/hikaru/stats');
    expect(up.calls).not.toContain('POST lichess.org/api/users');

    // Another client still has its share: the hits get the sites' facts.
    const full = await search({ db: t.db, upstream: t.app.upstream, cache: new SearchCache(), client: 'user:901' }, 'hikaru', null);
    expect(full.chesscom[0]!.ratings?.length).toBeGreaterThan(0);
    expect(full.lichess[0]!.ratings?.length).toBeGreaterThan(0);
    expect(up.calls).toContain('GET api.chess.com/pub/player/hikaru/stats');
    expect(up.calls).toContain('POST lichess.org/api/users');
  });
});
