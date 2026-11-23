import type { SearchResults } from '@outpost/shared/api';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { insertGame, pgnSourceKey } from '../src/chess/store.ts';
import { foldName } from '../src/reference/players.ts';
import type { AuthUser } from '../src/http/types.ts';
import { knownUsernames, search as runSearch, SearchCache, visibleProfileSlugFor } from '../src/search/index.ts';
import { writeSettings } from '../src/settings.ts';
import { chesscomSnapshot } from '../src/sync/chesscom.ts';
import { createSource, createUserSession, makeTestApp, testGame, type TestApp } from './helpers.ts';
import { fakeUpstream, HIKARU_PLAYER, HIKARU_STATS, json, lichessUser, networkDown, stalledJson } from './fixtures/profiles/upstream.ts';

type Session = { userId: number; cookie: string };

describe('search API', () => {
  let t: TestApp;
  let up: ReturnType<typeof fakeUpstream>;
  let me: Session;
  let other: Session;
  /** Bodies of `POST /api/users`. */
  const usersAsked: string[] = [];

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
      'GET api.chess.com/pub/player/hikaru/stats': () => json(HIKARU_STATS),
      // Synthetic accounts; Alistair has no Lichess account.
      'POST lichess.org/api/users': (_url, init) => {
        usersAsked.push(String(init.body));
        const known: Record<string, Record<string, unknown>> = {
          alice: lichessUser('Alice', { title: 'FM', flag: 'GB-SCT', blitz: 2310, bulletGames: 40 }),
          alina: lichessUser('Alina', { disabled: true }),
          alibi_bot: lichessUser('Alibi_Bot', { title: 'BOT' }),
        };
        return json(String(init.body).split(',').flatMap(id => (known[id] ? [known[id]] : [])));
      },
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
    expect(up.calls.sort()).toEqual(['GET api.chess.com/pub/player/ali', 'GET lichess.org/api/player/autocomplete', 'POST lichess.org/api/users']);
    // One request for every Lichess hit's facts.
    expect(usersAsked.at(-1)).toBe('alice,alistair,alina,alibi_bot');
    expect(r.profiles.map(p => p.slug)).toEqual(['my-alibaba', 'alice-public']);
    // Best first (an account with a profile here, then one seen in imported games), upstream order
    // among equals. The hidden account of someone else's profile (no games yet) is not known to me.
    // Each Lichess account carries its ratings (time classes played), last seen, games, flag.
    const facts = (over: Record<string, unknown> = {}) => ({
      ratings: [
        { timeClass: 'blitz', rating: 1873, games: 120, provisional: false },
        { timeClass: 'rapid', rating: 1640, games: 3, provisional: true },
      ],
      seenAt: 1_700_000_000_000,
      games: 123,
      country: null,
      closed: false,
      ...over,
    });
    expect(r.lichess).toEqual([
      {
        kind: 'lichess',
        username: 'Alice',
        title: 'FM',
        exists: true,
        known: true,
        profileSlug: 'alice-public',
        ...facts({
          ratings: [
            { timeClass: 'bullet', rating: 1500, games: 40, provisional: true },
            { timeClass: 'blitz', rating: 2310, games: 120, provisional: false },
            { timeClass: 'rapid', rating: 1640, games: 3, provisional: true },
          ],
          games: 163,
          country: 'GB',
        }),
      },
      { kind: 'lichess', username: 'Alistair', title: 'CM', exists: false, known: true, profileSlug: null },
      { kind: 'lichess', username: 'Alina', title: null, exists: true, known: false, profileSlug: null, ...facts({ closed: true }) },
      { kind: 'lichess', username: 'Alibi_Bot', title: 'BOT', exists: true, known: false, profileSlug: null, ...facts() },
    ]);
    // Chess.com has no search: the exact check found nothing, local accounts match by prefix (with
    // the country Outpost's opponent lookups found).
    expect(r.chesscom).toEqual([
      { kind: 'chesscom', username: 'AliBaba', title: null, exists: false, known: true, profileSlug: 'my-alibaba' },
      { kind: 'chesscom', username: 'Aliyev', title: 'IM', exists: false, known: true, profileSlug: null, country: 'AZ' },
    ]);
    expect(r.reference).toEqual([]);
    expect(r.unavailable).toBeUndefined();
    expect(r.notSearched).toBeUndefined();
  });

  it('says which sites a name that cannot be a username was not sent to', async () => {
    const r = await results(me, 'McShane, Luke');
    expect(up.calls).toEqual([]);
    expect(r.notSearched).toEqual(['lichess', 'chesscom']);
    expect([r.lichess, r.chesscom]).toEqual([[], []]);
    // Two characters: too short for Lichess's autocomplete and the Chess.com check; local hits still count.
    expect((await results(me, 'al')).notSearched).toEqual(['lichess', 'chesscom']);
  });

  it('finds reference players for the viewer: private reference databases for admins, own profiles', async () => {
    const admin = createUserSession(t.db, { username: 'boss', role: 'admin' });
    const refDb = (name: string, visibility: 'public' | 'private') =>
      t.db.run("INSERT INTO databases (name, kind, visibility, created_at) VALUES (?, 'reference', ?, 0)", [name, visibility]).lastInsertRowid;
    const player = (databaseId: number, name: string) => {
      const id = t.db.run(
        `INSERT INTO reference_players (database_id, name_key, name, search_name, games, updated_at) VALUES (?, ?, ?, ?, 3, 0)`,
        [databaseId, foldName(name), name, foldName(name)],
      ).lastInsertRowid;
      for (const w of foldName(name).split(' ')) t.db.run('INSERT INTO reference_player_words (word, player_id) VALUES (?, ?)', [w, id]);
    };
    const open = refDb('Open archive', 'public');
    const licensed = refDb('Licensed OTB', 'private');
    player(open, 'Zebulon Openhand');
    player(licensed, 'Zebulon Closedhand');
    const src = createSource(t.db, { kind: 'pgn', key: pgnSourceKey(open, 'Zebulon Openhand'), displayName: 'Zebulon Openhand', databaseId: open });
    addProfile('my-zebulon', 'My Zebulon', me.userId, 'private', [[src, false]]);

    const names = (r: SearchResults) => r.reference.map(p => p.name).sort();
    expect(names(await results(me, 'zebulon'))).toEqual(['Zebulon Openhand']);
    expect(names(await results(admin, 'zebulon'))).toEqual(['Zebulon Closedhand', 'Zebulon Openhand']);
    // My private profile with that pgn source is the player's profile for me, not for others.
    expect((await results(me, 'zebulon')).reference[0]!.profileSlug).toBe('my-zebulon');
    expect((await results(other, 'zebulon')).reference[0]!.profileSlug).toBeNull();
  });

  it('puts the exact match first and confirms Chess.com accounts', async () => {
    const r = await results(me, 'Hikaru');
    // The exact account with its profile and /stats: ratings, last seen, games, country.
    expect(r.chesscom[0]).toEqual({
      kind: 'chesscom',
      username: 'Hikaru',
      title: 'GM',
      exists: true,
      known: false,
      profileSlug: null,
      ratings: [
        { timeClass: 'bullet', rating: 3250, games: 6, provisional: false },
        { timeClass: 'blitz', rating: 3300, games: 15, provisional: false },
      ],
      seenAt: 1_763_000_000_000,
      games: 21,
      country: 'US',
      closed: false,
    });
    expect(up.calls).toContain('GET api.chess.com/pub/player/hikaru/stats');
    const alice = await results(me, 'alice');
    expect(alice.lichess[0]!.username).toBe('Alice');
  });

  it('caches upstream answers for a minute', async () => {
    await results(me, 'alina');
    const n = up.calls.length;
    await results(other, 'ALINA');
    expect(up.calls.length).toBe(n);
    // Autocomplete and Chess.com; Alina's Lichess facts are still cached from the first search.
    expect(n).toBe(2);
    expect(up.calls).not.toContain('POST lichess.org/api/users');
  });

  it("uses Outpost's last sync of an account, and lists hits without facts when the lookup fails", async () => {
    const snap = chesscomSnapshot(
      { username: 'alibaba', url: 'https://www.chess.com/member/AliBaba', country: 'https://api.chess.com/pub/country/EG', last_online: 1_700_000 },
      { chess_rapid: { last: { rating: 1999 }, record: { win: 7, loss: 2, draw: 1 } } },
      1,
    );
    t.db.run("UPDATE sources SET profile_json = ? WHERE kind = 'chesscom' AND key = 'alibaba'", [JSON.stringify(snap)]);
    const r = await results(me, 'alibab');
    expect(r.chesscom[0]).toMatchObject({
      username: 'AliBaba',
      ratings: [{ timeClass: 'rapid', rating: 1999, games: 10, provisional: false }],
      seenAt: 1_700_000_000,
      games: 10,
      country: 'EG',
    });
    // Lichess's users lookup down: the hits stay, without facts, and Lichess is not "unavailable".
    const saved = up.routes['POST lichess.org/api/users']!;
    up.routes['POST lichess.org/api/users'] = networkDown;
    try {
      const down = await runSearch({ db: t.db, upstream: t.app.upstream, cache: new SearchCache() }, 'alib', null);
      expect(down.unavailable).toBeUndefined();
      expect(down.lichess.map(h => [h.username, h.ratings])).toEqual([['Alibi_Bot', undefined]]);
    } finally {
      up.routes['POST lichess.org/api/users'] = saved;
    }
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
