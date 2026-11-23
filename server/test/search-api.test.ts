import type { SearchResults } from '@outpost/shared/api';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { insertGame } from '../src/chess/store.ts';
import type { AuthUser } from '../src/http/types.ts';
import { knownUsernames, search as runSearch, SearchCache, visibleProfileSlugFor } from '../src/search/index.ts';
import { writeSettings } from '../src/settings.ts';
import { createSource, createUserSession, makeTestApp, testGame, type TestApp } from './helpers.ts';
import { fakeUpstream, HIKARU_PLAYER, json, networkDown, stalledJson } from './fixtures/profiles/upstream.ts';

type Session = { userId: number; cookie: string };

describe('search API', () => {
  let t: TestApp;
  let up: ReturnType<typeof fakeUpstream>;
  let me: Session;
  let other: Session;

  const search = async (s: Session | null, q: string) => {
    const res = await t.app.inject({ url: `/api/search?q=${encodeURIComponent(q)}`, headers: s ? { cookie: s.cookie } : {} });
    return res;
  };
  const results = async (s: Session | null, q: string): Promise<SearchResults> => {
    const res = await search(s, q);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<SearchResults>();
  };
  const addProfile = (slug: string, name: string, ownerId: number, visibility: 'public' | 'private', sources: Array<[number, boolean]>, views = 0) => {
    const id = t.db.run(
      'INSERT INTO profiles (slug, display_name, owner_user_id, visibility, created_at, updated_at, views) VALUES (?, ?, ?, ?, 0, 0, ?)',
      [slug, name, ownerId, visibility, views],
    ).lastInsertRowid;
    for (const [src, hidden] of sources) t.db.run('INSERT INTO profile_sources (profile_id, source_id, hidden) VALUES (?, ?, ?)', [id, src, hidden]);
    return id;
  };

  beforeAll(async () => {
    up = fakeUpstream({
      'GET lichess.org/api/player/autocomplete': url => {
        const term = url.searchParams.get('term')!.toLowerCase();
        expect(url.searchParams.get('object')).toBe('true');
        const all = [
          { id: 'alice', name: 'Alice', title: 'FM', online: true },
          { id: 'alina', name: 'Alina' },
          { id: 'alibi_bot', name: 'Alibi_Bot', title: 'BOT' },
        ];
        return json({ result: all.filter(u => u.id.startsWith(term)) });
      },
      'GET api.chess.com/pub/player/hikaru': () => json(HIKARU_PLAYER),
    });
    t = await makeTestApp({ fetch: up.fetch });
    me = createUserSession(t.db, { username: 'me' });
    other = createUserSession(t.db, { username: 'other' });

    const alice = createSource(t.db, { kind: 'lichess', key: 'alice', displayName: 'Alice' });
    t.db.run('UPDATE sources SET last_synced_at = 1 WHERE id = ?', [alice]);
    const alibaba = createSource(t.db, { kind: 'chesscom', key: 'alibaba', displayName: 'AliBaba' });
    const hidden = createSource(t.db, { kind: 'lichess', key: 'alias-hidden', displayName: 'alias-hidden' });
    t.db.run("INSERT INTO players_cache (kind, key, country, title, name, fetched_at) VALUES ('chesscom', 'aliyev', 'AZ', 'IM', 'Aliyev', 1)");
    // An opponent seen in imported games.
    insertGame(t.db, testGame({ white: { name: 'alice' }, black: { name: 'Alistair', title: 'CM' } }));

    addProfile('alice-public', 'Alice in Chessland', other.userId, 'public', [[alice, false]], 5);
    addProfile('alien-private', 'Alien', other.userId, 'private', [[alibaba, false]]);
    addProfile('my-alibaba', 'Mine', me.userId, 'private', [[alibaba, false]]);
    addProfile('masked', 'Masked', other.userId, 'public', [[hidden, true]]);
  });
  afterAll(async () => t.close());
  beforeEach(() => {
    up.calls.length = 0;
  });

  it('combines local profiles, Lichess autocomplete, Chess.com and known usernames', async () => {
    const r = await results(me, 'ali');
    expect(r.q).toBe('ali');
    expect(up.calls.sort()).toEqual(['GET api.chess.com/pub/player/ali', 'GET lichess.org/api/player/autocomplete']);
    expect(r.profiles.map(p => p.slug)).toEqual(['my-alibaba', 'alice-public']);
    expect(r.lichess).toEqual([
      { kind: 'lichess', username: 'Alice', title: 'FM', exists: true, known: true, profileSlug: 'alice-public' },
      { kind: 'lichess', username: 'Alina', title: null, exists: true, known: false, profileSlug: null },
      { kind: 'lichess', username: 'Alibi_Bot', title: 'BOT', exists: true, known: false, profileSlug: null },
      // Known locally only (in key order). The hidden account of someone else's profile (no games
      // yet) is not known to me.
      { kind: 'lichess', username: 'Alistair', title: 'CM', exists: false, known: true, profileSlug: null },
    ]);
    // Chess.com has no search: the exact check found nothing, local accounts match by prefix.
    expect(r.chesscom).toEqual([
      { kind: 'chesscom', username: 'AliBaba', title: null, exists: false, known: true, profileSlug: 'my-alibaba' },
      { kind: 'chesscom', username: 'Aliyev', title: 'IM', exists: false, known: true, profileSlug: null },
    ]);
    expect(r.reference).toEqual([]);
    expect(r.unavailable).toBeUndefined();
  });

  it('puts the exact match first and confirms Chess.com accounts', async () => {
    const r = await results(me, 'Hikaru');
    expect(r.chesscom[0]).toEqual({ kind: 'chesscom', username: 'Hikaru', title: 'GM', exists: true, known: false, profileSlug: null });
    const alice = await results(me, 'alice');
    expect(alice.lichess[0]!.username).toBe('Alice');
  });

  it('caches upstream answers for a minute', async () => {
    await results(me, 'alina');
    const n = up.calls.length;
    await results(other, 'ALINA');
    expect(up.calls.length).toBe(n);
    expect(n).toBe(2);
  });

  it('keeps local results when an upstream fails', async () => {
    const saved = up.routes['GET lichess.org/api/player/autocomplete']!;
    up.routes['GET lichess.org/api/player/autocomplete'] = networkDown;
    up.routes['GET api.chess.com/pub/player/alis'] = () => json({}, 503);
    try {
      const r = await results(me, 'alis');
      expect(r.unavailable).toEqual(['lichess', 'chesscom']);
      expect(r.lichess.map(h => h.username)).toEqual(['Alistair']);
    } finally {
      up.routes['GET lichess.org/api/player/autocomplete'] = saved;
    }
  });

  it('skips upstream lookups that cannot match and hides private or hidden data', async () => {
    const r = await results(other, 'Alien');
    expect(r.profiles.map(p => p.slug)).toEqual(['alien-private']);
    up.calls.length = 0;
    const spaced = await results(me, 'in chess');
    expect(up.calls).toEqual([]);
    expect(spaced.profiles.map(p => p.slug)).toEqual(['alice-public']);
    expect(spaced.lichess).toEqual([]);
    // A hidden account doesn't make its profile findable (except for its owner).
    expect((await results(me, 'alias-hidden')).profiles).toEqual([]);
    expect((await results(other, 'alias-hidden')).profiles.map(p => p.slug)).toEqual(['masked']);
    expect(visibleProfileSlugFor(t.db, 'lichess', 'alias-hidden', null)).toBeNull();
    // Two characters: local only (Lichess needs 3, Chess.com usernames have 3+).
    up.calls.length = 0;
    await results(me, 'al');
    expect(up.calls).toEqual([]);
  });

  it('validates the query and the session', async () => {
    expect((await search(me, 'a')).statusCode).toBe(400);
    expect((await search(me, 'x'.repeat(101))).statusCode).toBe(400);
    expect((await search(null, 'alice')).statusCode).toBe(401);
    writeSettings(t.db, { anonymousBrowsing: true });
    const anon = await results(null, 'ali');
    expect(anon.profiles.map(p => p.slug)).toEqual(['alice-public']);
    writeSettings(t.db, { anonymousBrowsing: false });
  });

  it('finds known usernames by prefix with an index-friendly range', () => {
    expect(knownUsernames(t.db, 'lichess', 'AL', null).map(h => h.username)).toEqual(['Alice', 'Alistair']);
    // The profile's owner sees its hidden account.
    const owner = { id: other.userId, username: 'other', role: 'user', totpEnabled: false, prefs: {} } as AuthUser;
    expect(knownUsernames(t.db, 'lichess', 'AL', owner).map(h => h.username)).toEqual(['alias-hidden', 'Alice', 'Alistair']);
    expect(knownUsernames(t.db, 'chesscom', 'aliy', null)).toEqual([{ username: 'Aliyev', title: 'IM' }]);
    expect(knownUsernames(t.db, 'lichess', 'zz', null)).toEqual([]);
    const cache = new SearchCache(() => 0);
    cache.set('a', 1);
    expect(cache.get('a')).toBe(1);
  });

  it("doesn't reveal accounts only a private profile tracks", async () => {
    const secret = createSource(t.db, { kind: 'lichess', key: 'secretguy', displayName: 'SecretGuy' });
    addProfile('secret-dossier', 'Dossier', me.userId, 'private', [[secret, false]]);
    const saved = up.routes['GET lichess.org/api/player/autocomplete']!;
    up.routes['GET lichess.org/api/player/autocomplete'] = () => json({ result: [] });
    try {
      // Someone else: no local hit, and nothing marks the account as tracked.
      expect((await results(other, 'secret')).lichess).toEqual([]);
      const exact = await results(other, 'SecretGuy');
      expect(exact.lichess).toEqual([]);
      // The owner finds it through their own profile.
      expect((await results(me, 'secret')).lichess).toEqual([
        { kind: 'lichess', username: 'SecretGuy', title: null, exists: false, known: true, profileSlug: 'secret-dossier' },
      ]);
      // Once games are imported the account is known to everyone (but its profile stays private).
      insertGame(t.db, testGame({ white: { name: 'SecretGuy' }, black: { name: 'zed' } }));
      expect((await results(other, 'secretg')).lichess).toEqual([
        { kind: 'lichess', username: 'SecretGuy', title: null, exists: false, known: true, profileSlug: null },
      ]);
    } finally {
      up.routes['GET lichess.org/api/player/autocomplete'] = saved;
    }
  });

  it('gives up on an upstream that stalls in the middle of its body', async () => {
    const stalled = fakeUpstream({
      'GET api.chess.com/pub/player/slowpoke': () => stalledJson(),
      'GET lichess.org/api/player/autocomplete': () => stalledJson(),
    });
    const s = await makeTestApp({ fetch: stalled.fetch });
    try {
      const started = Date.now();
      const r = await runSearch({ db: s.db, upstream: s.app.upstream, cache: new SearchCache(), timeoutMs: 150 }, 'slowpoke', null);
      expect(Date.now() - started).toBeLessThan(2000);
      expect(r.unavailable).toEqual(['lichess', 'chesscom']);
      expect(r.lichess).toEqual([]);
      // A client that goes away cancels the lookups at once.
      const gone = new AbortController();
      const pending = runSearch({ db: s.db, upstream: s.app.upstream, cache: new SearchCache(), signal: gone.signal }, 'slowpoke', null);
      gone.abort();
      expect((await pending).unavailable).toEqual(['lichess', 'chesscom']);
    } finally {
      await s.close();
    }
  });

  it('throttles searches per IP', async () => {
    let status = 0;
    for (let i = 0; i < 61 && status !== 429; i++) status = (await search(me, 'al')).statusCode;
    expect(status).toBe(429);
    expect((await search(me, 'al')).json().error.code).toBe('rate_limited');
  });
});
