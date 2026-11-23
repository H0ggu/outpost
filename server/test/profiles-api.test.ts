import type { ProfileHeader, ProfileListResponse, ProfileStatus, ProfileUpdateResponse } from '@outpost/shared/api';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { insertGame } from '../src/chess/store.ts';
import { MAX_PROFILES_PER_USER } from '../src/profiles/service.ts';
import { writeSettings } from '../src/settings.ts';
import { createUserSession, makeTestApp, mutationHeaders, testGame, type TestApp } from './helpers.ts';
import { fakeUpstream, hikaruRoutes, json, lichessUser, networkDown } from './fixtures/profiles/upstream.ts';

type Session = { userId: number; cookie: string };

describe('profiles API', () => {
  let t: TestApp;
  let up: ReturnType<typeof fakeUpstream>;
  let owner: Session;
  let other: Session;
  let admin: Session;

  const req = (s: Session | null, method: string, url: string, payload?: unknown) =>
    t.app.inject({
      method: method as 'GET',
      url,
      headers: { ...(method === 'GET' ? {} : mutationHeaders), ...(s ? { cookie: s.cookie } : {}) },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });

  const create = async (s: Session, body: unknown): Promise<ProfileHeader> => {
    const res = await req(s, 'POST', '/api/profiles', body);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<ProfileHeader>();
  };

  beforeAll(async () => {
    up = fakeUpstream({
      ...hikaruRoutes(),
      'GET lichess.org/api/user/alice': () => json(lichessUser('Alice', { title: 'FM', flag: 'NO', fideRating: 2310 })),
      'GET lichess.org/api/user/bob': () => json(lichessUser('Bob')),
      'GET lichess.org/api/user/carol': () => json(lichessUser('Carol')),
      'GET lichess.org/api/user/dave': () => json(lichessUser('Dave')),
      'GET lichess.org/api/user/closed': () => json(lichessUser('closed', { disabled: true })),
    });
    t = await makeTestApp({ fetch: up.fetch });
    owner = createUserSession(t.db, { username: 'owner' });
    other = createUserSession(t.db, { username: 'other' });
    admin = createUserSession(t.db, { username: 'boss', role: 'admin' });
  });
  afterAll(async () => t.close());
  beforeEach(() => {
    up.calls.length = 0;
  });

  it('creates a profile from upstream-checked accounts and queues the first syncs', async () => {
    const h = await create(owner, {
      displayName: 'Alice Ålesund',
      sources: [
        { kind: 'lichess', key: 'Alice' },
        { kind: 'chesscom', key: 'Hikaru' },
      ],
    });
    expect(h).toMatchObject({
      slug: 'alice-alesund',
      displayName: 'Alice Ålesund',
      visibility: 'private',
      autoRefresh: false,
      owner: { id: owner.userId, username: 'owner' },
      canEdit: true,
      bookmarked: false,
      totals: { w: 0, d: 0, l: 0, games: 0 },
      lastUpdated: null,
      views: 0,
    });
    expect(up.calls).toEqual([
      'GET lichess.org/api/user/alice',
      'GET api.chess.com/pub/player/hikaru',
      'GET api.chess.com/pub/player/hikaru/stats',
    ]);
    const [li, cc] = h.sources;
    expect(li).toMatchObject({
      kind: 'lichess',
      key: 'alice',
      displayName: 'Alice',
      url: 'https://lichess.org/@/Alice',
      title: 'FM',
      country: 'NO',
      hidden: false,
      databaseId: null,
      gameCount: 0,
      fide: { standard: 2310, rapid: null, blitz: null },
      sync: { state: 'queued', queuePosition: 1 },
    });
    // Snapshot ratings: perfs with games only (bullet had none).
    expect(li!.ratings).toEqual([
      { timeClass: 'blitz', rating: 1873, games: 0, rd: 61, provisional: false },
      { timeClass: 'rapid', rating: 1640, games: 0, rd: 140, provisional: true },
    ]);
    expect(cc).toMatchObject({
      kind: 'chesscom',
      key: 'hikaru',
      displayName: 'Hikaru',
      url: 'https://www.chess.com/member/Hikaru',
      title: 'GM',
      country: 'US',
      fide: { standard: 2800, rapid: null, blitz: null },
      sync: { state: 'queued' },
    });
    expect(cc!.ratings.map(r => [r.timeClass, r.rating])).toEqual([
      ['bullet', 3250],
      ['blitz', 3300],
    ]);
    expect(h.queue).toEqual({ busy: true, cooldownUntil: null, queuePosition: 1 });
    const jobs = t.db.all<{ kind: string; lane: string; user_id: number; priority: number }>(
      "SELECT kind, lane, user_id, priority FROM jobs WHERE kind = 'sync' ORDER BY id",
    );
    expect(jobs).toEqual([
      { kind: 'sync', lane: 'lichess', user_id: owner.userId, priority: 10 },
      { kind: 'sync', lane: 'chesscom', user_id: owner.userId, priority: 10 },
    ]);
  });

  it('reuses existing source rows without asking upstream again', async () => {
    const h = await create(other, { displayName: 'Alice again', sources: [{ kind: 'lichess', key: 'ALICE' }] });
    expect(up.calls).toEqual([]);
    expect(h.slug).toBe('alice-again');
    expect(t.db.value('SELECT COUNT(*) FROM sources WHERE kind = ? AND key = ?', ['lichess', 'alice'])).toBe(1);
    // Still queued from the first profile: no second job.
    expect(t.db.value('SELECT COUNT(*) FROM jobs WHERE dedupe_key = ?', [`sync:${h.sources[0]!.id}`])).toBe(1);
  });

  it('checks each requested account once', async () => {
    up.routes['GET lichess.org/api/user/ivy'] = () => json(lichessUser('Ivy'));
    const h = await create(owner, {
      displayName: 'Ivy',
      sources: [
        { kind: 'lichess', key: 'Ivy' },
        { kind: 'lichess', key: ' ivy ' },
      ],
    });
    expect(up.calls).toEqual(['GET lichess.org/api/user/ivy']);
    expect(h.sources.map(s => s.key)).toEqual(['ivy']);
    // HEAD requests are not views.
    await t.app.inject({ method: 'HEAD', url: `/api/profiles/${h.slug}`, headers: { cookie: other.cookie } });
    expect(t.db.value('SELECT COUNT(*) FROM profile_views WHERE profile_id = ?', [h.id])).toBe(0);
  });

  it('makes slugs unique and validates explicit ones', async () => {
    const a = await create(owner, { displayName: 'Same Name', sources: [{ kind: 'lichess', key: 'bob' }] });
    const b = await create(owner, { displayName: 'Same Name', sources: [{ kind: 'lichess', key: 'bob' }] });
    expect([a.slug, b.slug]).toEqual(['same-name', 'same-name-2']);
    const taken = await req(owner, 'POST', '/api/profiles', { displayName: 'X', slug: 'same-name', sources: [{ kind: 'lichess', key: 'bob' }] });
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error.code).toBe('conflict');
    // A taken address is refused before any account is checked upstream.
    up.calls.length = 0;
    const takenNew = await req(owner, 'POST', '/api/profiles', { displayName: 'X', slug: 'same-name', sources: [{ kind: 'lichess', key: 'neverchecked' }] });
    expect(takenNew.statusCode).toBe(409);
    expect(up.calls).toEqual([]);
    const bad = await req(owner, 'POST', '/api/profiles', { displayName: 'X', slug: 'Bad Slug', sources: [{ kind: 'lichess', key: 'bob' }] });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('validation');
    const odd = await create(owner, { displayName: '!!', sources: [{ kind: 'lichess', key: 'bob' }] });
    expect(odd.slug).toBe('player-x');
  });

  it('rejects unknown, closed and malformed accounts and reports upstream outages', async () => {
    const unknown = await req(owner, 'POST', '/api/profiles', { displayName: 'Nobody', sources: [{ kind: 'lichess', key: 'nobody' }] });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error).toMatchObject({ code: 'validation', message: 'No Lichess account "nobody"' });
    const closed = await req(owner, 'POST', '/api/profiles', { displayName: 'C', sources: [{ kind: 'lichess', key: 'closed' }] });
    expect(closed.statusCode).toBe(400);
    expect(closed.json().error.message).toMatch(/closed/);
    const malformed = await req(owner, 'POST', '/api/profiles', { displayName: 'M', sources: [{ kind: 'chesscom', key: 'no spaces!' }] });
    expect(malformed.statusCode).toBe(400);
    expect(up.calls).not.toContain('GET api.chess.com/pub/player/no spaces!');
    const none = await req(owner, 'POST', '/api/profiles', { displayName: 'Empty', sources: [] });
    expect(none.statusCode).toBe(400);
    up.routes['GET lichess.org/api/user/eve'] = networkDown;
    const down = await req(owner, 'POST', '/api/profiles', { displayName: 'Eve', sources: [{ kind: 'lichess', key: 'eve' }] });
    expect(down.statusCode).toBe(503);
    expect(down.json().error.code).toBe('upstream_unavailable');
    up.routes['GET api.chess.com/pub/player/broken'] = () => json({ message: 'internal' }, 500);
    const broken = await req(owner, 'POST', '/api/profiles', { displayName: 'B', sources: [{ kind: 'chesscom', key: 'broken' }] });
    expect(broken.statusCode).toBe(502);
    // Nothing half-created.
    expect(t.db.value("SELECT COUNT(*) FROM profiles WHERE display_name IN ('Nobody', 'C', 'M', 'Empty', 'Eve', 'B')")).toBe(0);
  });

  it('requires a session to create and hides private profiles from others', async () => {
    const anon = await req(null, 'POST', '/api/profiles', { displayName: 'A', sources: [{ kind: 'lichess', key: 'bob' }] });
    expect(anon.statusCode).toBe(401);
    const h = await create(owner, { displayName: 'Private one', sources: [{ kind: 'lichess', key: 'bob' }] });
    expect((await req(owner, 'GET', `/api/profiles/${h.slug}`)).statusCode).toBe(200);
    expect((await req(admin, 'GET', `/api/profiles/${h.slug}`)).json<ProfileHeader>().canEdit).toBe(true);
    for (const url of [`/api/profiles/${h.slug}`, `/api/profiles/${h.slug}/status`]) {
      expect((await req(other, 'GET', url)).statusCode, url).toBe(404);
      expect((await req(null, 'GET', url)).statusCode, url).toBe(401);
    }
    for (const [method, url, body] of [
      ['PATCH', `/api/profiles/${h.slug}`, { displayName: 'x' }],
      ['DELETE', `/api/profiles/${h.slug}`, undefined],
      ['POST', `/api/profiles/${h.slug}/update`, undefined],
      ['PUT', `/api/profiles/${h.slug}/bookmark`, undefined],
      ['POST', `/api/profiles/${h.slug}/sources`, { kind: 'lichess', key: 'carol' }],
      ['DELETE', `/api/profiles/${h.slug}/sources/${h.sources[0]!.id}`, undefined],
    ] as const) {
      expect((await req(other, method, url, body)).statusCode, `${method} ${url}`).toBe(404);
      expect((await req(null, method, url, body)).statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('lets anonymous visitors read public profiles only when anonymous browsing is on', async () => {
    const h = await create(owner, { displayName: 'Public one', visibility: 'public', sources: [{ kind: 'lichess', key: 'bob' }] });
    expect((await req(null, 'GET', `/api/profiles/${h.slug}`)).statusCode).toBe(401);
    writeSettings(t.db, { anonymousBrowsing: true });
    try {
      const res = await req(null, 'GET', `/api/profiles/${h.slug}`);
      expect(res.statusCode).toBe(200);
      expect(res.json<ProfileHeader>()).toMatchObject({ canEdit: false, bookmarked: false });
      expect((await req(null, 'GET', `/api/profiles/${h.slug}/status`)).statusCode).toBe(200);
      expect((await req(null, 'GET', '/api/profiles?scope=public')).json<ProfileListResponse>().profiles.map(p => p.slug)).toContain(h.slug);
      expect((await req(null, 'GET', '/api/profiles?scope=mine')).statusCode).toBe(401);
      expect((await req(null, 'GET', '/api/profiles')).statusCode).toBe(200);
      // Private profiles still 404.
      const priv = await create(owner, { displayName: 'Still private', sources: [{ kind: 'lichess', key: 'bob' }] });
      expect((await req(null, 'GET', `/api/profiles/${priv.slug}`)).statusCode).toBe(404);
    } finally {
      writeSettings(t.db, { anonymousBrowsing: false });
    }
  });

  it('edits name, address, visibility, auto refresh and hidden accounts (owner or admin only)', async () => {
    const h = await create(owner, {
      displayName: 'Editable',
      visibility: 'public',
      sources: [
        { kind: 'lichess', key: 'carol' },
        { kind: 'lichess', key: 'dave' },
      ],
    });
    const [carol, dave] = h.sources;
    insertGame(t.db, testGame({ white: { name: 'carol' }, black: { name: 'zed' } }));
    insertGame(t.db, testGame({ white: { name: 'dave' }, black: { name: 'zed' }, result: '0-1' }));

    expect((await req(other, 'PATCH', `/api/profiles/${h.slug}`, { displayName: 'Hijack' })).statusCode).toBe(403);
    const res = await req(owner, 'PATCH', `/api/profiles/${h.slug}`, {
      displayName: 'Edited',
      slug: 'edited-slug',
      autoRefresh: true,
      hiddenSourceIds: [dave!.id],
    });
    expect(res.statusCode, res.body).toBe(200);
    const edited = res.json<ProfileHeader>();
    expect(edited).toMatchObject({ slug: 'edited-slug', displayName: 'Edited', autoRefresh: true });
    expect(edited.sources.map(s => [s.key, s.hidden])).toEqual([
      ['carol', false],
      ['dave', true],
    ]);
    expect(edited.totals).toEqual({ w: 1, d: 0, l: 1, games: 2 });
    expect((await req(owner, 'GET', `/api/profiles/${h.slug}`)).statusCode).toBe(404);

    // Other viewers don't see the hidden account or its games.
    const seen = (await req(other, 'GET', '/api/profiles/edited-slug')).json<ProfileHeader>();
    expect(seen.sources.map(s => s.key)).toEqual(['carol']);
    expect(seen.totals).toEqual({ w: 1, d: 0, l: 0, games: 1 });
    expect(seen.canEdit).toBe(false);

    const foreign = await req(owner, 'PATCH', '/api/profiles/edited-slug', { hiddenSourceIds: [999_999] });
    expect(foreign.statusCode).toBe(400);
    const taken = await req(owner, 'PATCH', '/api/profiles/edited-slug', { slug: 'same-name' });
    expect(taken.statusCode).toBe(409);
    const asAdmin = await req(admin, 'PATCH', '/api/profiles/edited-slug', { visibility: 'private', hiddenSourceIds: [] });
    expect(asAdmin.statusCode).toBe(200);
    expect(asAdmin.json<ProfileHeader>()).toMatchObject({ visibility: 'private' });
    expect(asAdmin.json<ProfileHeader>().sources.every(s => !s.hidden)).toBe(true);
    expect((await req(other, 'GET', '/api/profiles/edited-slug')).statusCode).toBe(404);
    expect(carol!.kind).toBe('lichess');
  });

  it('computes current ratings from stored games when there is no snapshot', async () => {
    const h = await create(owner, { displayName: 'Rated', sources: [{ kind: 'lichess', key: 'carol' }] });
    t.db.run("UPDATE sources SET profile_json = NULL WHERE kind = 'lichess' AND key = 'carol'");
    insertGame(t.db, testGame({ white: { name: 'carol', rating: 1700, ratingAfter: 1708 }, black: { name: 'x1' }, timeClass: 'rapid' }));
    insertGame(t.db, testGame({ white: { name: 'carol', rating: 1600 }, black: { name: 'x2' }, timeClass: 'rapid', rated: false }));
    const res = (await req(owner, 'GET', `/api/profiles/${h.slug}`)).json<ProfileHeader>();
    expect(res.sources[0]!.ratings).toEqual([
      { timeClass: 'blitz', rating: 1500, games: 1, rd: null, provisional: false },
      { timeClass: 'rapid', rating: 1708, games: 2, rd: null, provisional: false },
    ]);
  });

  it('adds and removes accounts, deleting sources and games nobody uses any more', async () => {
    up.routes['GET api.chess.com/pub/player/synth-cc'] = () =>
      json({ username: 'synth-cc', url: 'https://www.chess.com/member/Synth-CC', player_id: 1, country: 'https://api.chess.com/pub/country/XK' });
    up.routes['GET api.chess.com/pub/player/synth-cc/stats'] = networkDown; // optional: ignored
    const h = await create(owner, { displayName: 'Mixer', sources: [{ kind: 'lichess', key: 'carol' }] });
    const added = await req(owner, 'POST', `/api/profiles/${h.slug}/sources`, { kind: 'chesscom', key: 'Synth-CC' });
    expect(added.statusCode, added.body).toBe(200);
    const withCc = added.json<ProfileHeader>();
    expect(withCc.sources.map(s => s.key)).toEqual(['carol', 'synth-cc']);
    expect(withCc.sources[1]).toMatchObject({ displayName: 'Synth-CC', country: 'XK', ratings: [], fide: null });
    const dup = await req(owner, 'POST', `/api/profiles/${h.slug}/sources`, { kind: 'chesscom', key: 'SYNTH-CC' });
    expect(dup.statusCode).toBe(409);
    expect((await req(other, 'POST', `/api/profiles/${h.slug}/sources`, { kind: 'lichess', key: 'bob' })).statusCode).toBe(404);
    const unknown = await req(owner, 'POST', `/api/profiles/${h.slug}/sources`, { kind: 'chesscom', key: 'nobody-here' });
    expect(unknown.statusCode).toBe(400);

    const hikaruId = withCc.sources[1]!.id;
    const g1 = insertGame(t.db, testGame({ origin: 'chesscom', white: { name: 'synth-cc' }, black: { name: 'someone' } }));
    // A game against another tracked account stays when synth-cc goes.
    const g2 = insertGame(t.db, testGame({ origin: 'chesscom', white: { name: 'synth-cc' }, black: { name: 'hikaru2' } }));
    t.db.run("INSERT INTO sources (kind, key, display_name, created_at) VALUES ('chesscom', 'hikaru2', 'hikaru2', 0)");
    const h2 = t.db.value<number>("SELECT id FROM sources WHERE key = 'hikaru2'")!;
    t.db.run('INSERT INTO player_games (source_id, game_id, color, outcome, opp_name, opp_key, opp_source_kind, time_class, rated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
      h2,
      g2.gameId,
      'b',
      'l',
      'synth-cc',
      'synth-cc',
      'chesscom',
      'blitz',
      1,
    ]);
    const missing = await req(owner, 'DELETE', `/api/profiles/${h.slug}/sources/999999`);
    expect(missing.statusCode).toBe(404);
    const removed = await req(owner, 'DELETE', `/api/profiles/${h.slug}/sources/${hikaruId}`);
    expect(removed.statusCode).toBe(200);
    expect(removed.json<ProfileHeader>().sources.map(s => s.key)).toEqual(['carol']);
    expect(t.db.value('SELECT COUNT(*) FROM sources WHERE id = ?', [hikaruId])).toBe(0);
    expect(t.db.value('SELECT COUNT(*) FROM games WHERE id = ?', [g1.gameId])).toBe(0);
    expect(t.db.value('SELECT COUNT(*) FROM positions WHERE game_id = ?', [g1.gameId])).toBe(0);
    expect(t.db.value('SELECT COUNT(*) FROM games WHERE id = ?', [g2.gameId])).toBe(1);
  });

  it('deletes a profile but keeps sources other profiles use', async () => {
    const a = await create(owner, { displayName: 'Keeper', sources: [{ kind: 'lichess', key: 'dave' }] });
    const b = await create(owner, {
      displayName: 'Goner',
      sources: [
        { kind: 'lichess', key: 'dave' },
        { kind: 'lichess', key: 'Bob' },
      ],
    });
    // Bob is used by earlier profiles too; make a fresh orphan-to-be.
    up.routes['GET lichess.org/api/user/frank'] = () => json(lichessUser('Frank'));
    const added = await req(owner, 'POST', `/api/profiles/${b.slug}/sources`, { kind: 'lichess', key: 'frank' });
    const frankId = added.json<ProfileHeader>().sources.find(s => s.key === 'frank')!.id;
    const game = insertGame(t.db, testGame({ white: { name: 'frank' }, black: { name: 'nobody-tracked' } }));
    expect((await req(other, 'DELETE', `/api/profiles/${b.slug}`)).statusCode).toBe(404);
    t.db.run("INSERT INTO bookmarks (user_id, profile_id, created_at) VALUES (?, ?, 0)", [owner.userId, b.id]);
    const res = await req(owner, 'DELETE', `/api/profiles/${b.slug}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect((await req(owner, 'GET', `/api/profiles/${b.slug}`)).statusCode).toBe(404);
    expect(t.db.value('SELECT COUNT(*) FROM sources WHERE id = ?', [frankId])).toBe(0);
    expect(t.db.value('SELECT COUNT(*) FROM games WHERE id = ?', [game.gameId])).toBe(0);
    expect(t.db.value('SELECT COUNT(*) FROM bookmarks WHERE profile_id = ?', [b.id])).toBe(0);
    expect((await req(owner, 'GET', `/api/profiles/${a.slug}`)).json<ProfileHeader>().sources.map(s => s.key)).toEqual(['dave']);
    expect(t.db.value("SELECT COUNT(*) FROM sources WHERE kind = 'lichess' AND key = 'bob'")).toBe(1);
  });

  it('lets any signed-in viewer update; the cooldown applies to everyone but admins, who get high priority', async () => {
    writeSettings(t.db, { updateCooldownMinutes: 30 });
    up.routes['GET lichess.org/api/user/gina'] = () => json(lichessUser('Gina'));
    const h = await create(owner, { displayName: 'Updater', visibility: 'public', sources: [{ kind: 'lichess', key: 'gina' }] });
    const sourceId = h.sources[0]!.id;
    // Pretend the first sync finished.
    t.db.run("UPDATE jobs SET status = 'done' WHERE dedupe_key = ?", [`sync:${sourceId}`]);
    t.db.run('UPDATE sources SET last_synced_at = ? WHERE id = ?', [Date.now() - 3_600_000, sourceId]);

    expect((await req(other, 'GET', `/api/profiles/${h.slug}`)).json<ProfileHeader>()).toMatchObject({ canEdit: false, canUpdate: true });
    // Another signed-in viewer of the public profile may update it (anonymous visitors may not).
    expect((await req(null, 'POST', `/api/profiles/${h.slug}/update`)).statusCode).toBe(401);
    const first = await req(other, 'POST', `/api/profiles/${h.slug}/update`);
    expect(first.statusCode, first.body).toBe(200);
    const body = first.json<ProfileUpdateResponse>();
    expect(body.jobs).toHaveLength(1);
    expect(body.jobs[0]).toMatchObject({ kind: 'sync', status: 'queued', priority: 10, userId: other.userId });
    expect(body.queue.busy).toBe(true);
    expect(body.queue.cooldownUntil).toBeGreaterThan(Date.now() + 29 * 60_000);

    const again = await req(owner, 'POST', `/api/profiles/${h.slug}/update`);
    expect(again.statusCode).toBe(429);
    expect(again.json().error.code).toBe('cooldown');
    expect(again.json().error.details.retryAt).toBe(body.queue.cooldownUntil);

    const byAdmin = await req(admin, 'POST', `/api/profiles/${h.slug}/update`);
    expect(byAdmin.statusCode).toBe(200);
    const adminBody = byAdmin.json<ProfileUpdateResponse>();
    expect(adminBody.jobs[0]).toMatchObject({ id: body.jobs[0]!.id, priority: 20 });
    expect(adminBody.queue.cooldownUntil).toBeNull();

    const status = (await req(other, 'GET', `/api/profiles/${h.slug}/status`)).json<ProfileStatus>();
    expect(status.sources).toEqual([{ sourceId, sync: expect.objectContaining({ state: 'queued', jobId: body.jobs[0]!.id }), gameCount: 0 }]);
    expect(status.queue).toMatchObject({ busy: true, queuePosition: expect.any(Number) });
    expect(status.lastUpdated).toBeGreaterThan(0);
    writeSettings(t.db, { updateCooldownMinutes: 15 });
  });

  it("syncs only the sources a viewer sees when they ask for someone else's update", async () => {
    up.routes['GET lichess.org/api/user/hank'] = () => json(lichessUser('Hank'));
    up.routes['GET lichess.org/api/user/hidey'] = () => json(lichessUser('Hidey'));
    const h = await create(owner, { displayName: 'Two accounts', visibility: 'public', sources: [{ kind: 'lichess', key: 'hank' }, { kind: 'lichess', key: 'hidey' }] });
    const [shown, hidden] = h.sources.map(s => s.id) as [number, number];
    expect((await req(owner, 'PATCH', `/api/profiles/${h.slug}`, { hiddenSourceIds: [hidden] })).statusCode).toBe(200);
    t.db.run("UPDATE jobs SET status = 'done' WHERE dedupe_key IN (?, ?)", [`sync:${shown}`, `sync:${hidden}`]);
    const res = await req(other, 'POST', `/api/profiles/${h.slug}/update`);
    expect(res.statusCode, res.body).toBe(200);
    const jobs = res.json<ProfileUpdateResponse>().jobs;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.label).toMatch(/hank/i);
  });

  it('caps the profiles one user may own (admins excepted)', async () => {
    const heavy = createUserSession(t.db, { username: 'heavy' });
    const now = Date.now();
    for (let i = 0; i < MAX_PROFILES_PER_USER; i++) {
      t.db.run('INSERT INTO profiles (slug, display_name, owner_user_id, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [
        `heavy-${i}`,
        'x',
        heavy.userId,
        'private',
        now,
        now,
      ]);
    }
    up.routes['GET lichess.org/api/user/ivan'] = () => json(lichessUser('Ivan'));
    const res = await req(heavy, 'POST', '/api/profiles', { displayName: 'One more', sources: [{ kind: 'lichess', key: 'ivan' }] });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/at most 200 profiles/);
  });

  it('bookmarks visible profiles', async () => {
    const pub = await create(owner, { displayName: 'Bookmarkable', visibility: 'public', sources: [{ kind: 'lichess', key: 'bob' }] });
    const put = await req(other, 'PUT', `/api/profiles/${pub.slug}/bookmark`);
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ bookmarked: true });
    expect((await req(other, 'PUT', `/api/profiles/${pub.slug}/bookmark`)).json()).toEqual({ bookmarked: true });
    expect((await req(other, 'GET', `/api/profiles/${pub.slug}`)).json<ProfileHeader>().bookmarked).toBe(true);
    const list = (await req(other, 'GET', '/api/bookmarks')).json<ProfileListResponse>();
    expect(list.profiles.map(p => [p.slug, p.bookmarked])).toEqual([[pub.slug, true]]);
    expect((await req(null, 'GET', '/api/bookmarks')).statusCode).toBe(401);
    // Turning the profile private hides the bookmark from the list.
    await req(owner, 'PATCH', `/api/profiles/${pub.slug}`, { visibility: 'private' });
    expect((await req(other, 'GET', '/api/bookmarks')).json<ProfileListResponse>().profiles).toEqual([]);
    await req(owner, 'PATCH', `/api/profiles/${pub.slug}`, { visibility: 'public' });
    const del = await req(other, 'DELETE', `/api/profiles/${pub.slug}/bookmark`);
    expect(del.json()).toEqual({ bookmarked: false });
    expect((await req(other, 'GET', '/api/bookmarks')).json<ProfileListResponse>().profiles).toEqual([]);
  });

  it('counts views once per viewer per window (never the owner) and lists recently viewed', async () => {
    up.routes['GET lichess.org/api/user/hal'] = () => json(lichessUser('Hal'));
    const h = await create(owner, { displayName: 'Watched', visibility: 'public', sources: [{ kind: 'lichess', key: 'hal' }] });
    await req(owner, 'GET', `/api/profiles/${h.slug}`);
    await req(other, 'GET', `/api/profiles/${h.slug}`);
    await req(other, 'GET', `/api/profiles/${h.slug}`);
    await req(admin, 'GET', `/api/profiles/${h.slug}`);
    expect(t.db.value('SELECT views FROM profiles WHERE id = ?', [h.id])).toBe(2);
    expect((await req(owner, 'GET', `/api/profiles/${h.slug}`)).json<ProfileHeader>().views).toBe(2);
    // An hour later the same viewer counts again.
    t.db.run('UPDATE profile_views SET viewed_at = viewed_at - 3600000 WHERE user_id = ? AND profile_id = ?', [other.userId, h.id]);
    await req(other, 'GET', `/api/profiles/${h.slug}`);
    expect(t.db.value('SELECT views FROM profiles WHERE id = ?', [h.id])).toBe(3);
    writeSettings(t.db, { anonymousBrowsing: true });
    await req(null, 'GET', `/api/profiles/${h.slug}`);
    await req(null, 'GET', `/api/profiles/${h.slug}`);
    writeSettings(t.db, { anonymousBrowsing: false });
    expect(t.db.value('SELECT views FROM profiles WHERE id = ?', [h.id])).toBe(4);

    const recent = (await req(other, 'GET', '/api/profiles?scope=recent')).json<ProfileListResponse>();
    expect(recent.profiles[0]!.slug).toBe(h.slug);
    const mine = (await req(owner, 'GET', '/api/profiles?scope=mine')).json<ProfileListResponse>();
    expect(mine.profiles.length).toBeGreaterThan(5);
    expect(mine.profiles.every(p => p.owner?.id === owner.userId)).toBe(true);
    const pub = (await req(other, 'GET', '/api/profiles?scope=public')).json<ProfileListResponse>();
    expect(pub.profiles.every(p => p.visibility === 'public')).toBe(true);
    expect(pub.profiles[0]!.slug).toBe(h.slug); // most viewed first
    expect(pub.profiles[0]).toMatchObject({
      displayName: 'Watched',
      sources: [{ kind: 'lichess', key: 'hal', displayName: 'Hal', title: null, country: null }],
      gameCount: 0,
      lastUpdated: null,
      bookmarked: false,
    });
    expect((await req(other, 'GET', '/api/profiles?scope=nope')).statusCode).toBe(400);
  });
});
