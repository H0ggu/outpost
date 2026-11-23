import type { ProfileHeader } from '@outpost/shared/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertGame } from '../src/chess/store.ts';
import { collectUnreferencedGames, sweepOrphans } from '../src/profiles/service.ts';
import { insertSource, type ResolvedSource } from '../src/profiles/sources.ts';
import { createUserSession, makeTestApp, mutationHeaders, testGame, type TestApp } from './helpers.ts';
import { fakeUpstream, hikaruRoutes, json, lichessUser } from './fixtures/profiles/upstream.ts';

type Session = { userId: number; cookie: string };

/** The orphan policy: sync jobs of removed sources, id reuse, profiles deleted with their owner. */
describe('orphaned sources', () => {
  let t: TestApp;
  let owner: Session;

  const req = (s: Session, method: string, url: string, payload?: unknown) =>
    t.app.inject({
      method: method as 'GET',
      url,
      headers: { ...(method === 'GET' ? {} : mutationHeaders), cookie: s.cookie },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  const create = async (s: Session, body: unknown): Promise<ProfileHeader> => {
    const res = await req(s, 'POST', '/api/profiles', body);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<ProfileHeader>();
  };
  const jobOf = (sourceId: number) =>
    t.db.get<{ id: number; status: string; lane: string; payload_json: string }>(
      'SELECT id, status, lane, payload_json FROM jobs WHERE dedupe_key = ? ORDER BY id DESC LIMIT 1',
      [`sync:${sourceId}`],
    );

  beforeAll(async () => {
    const up = fakeUpstream({ ...hikaruRoutes() });
    for (const name of ['bob', 'erin', 'fay', 'gus', 'hal', 'ida']) up.routes[`GET lichess.org/api/user/${name}`] = () => json(lichessUser(name));
    t = await makeTestApp({ fetch: up.fetch });
    owner = createUserSession(t.db, { username: 'owner' });
  });
  afterAll(async () => t.close());

  it('cancels the queued sync of a removed account, and a new account never inherits its id', async () => {
    const h = await create(owner, { displayName: 'Two sites', sources: [{ kind: 'lichess', key: 'erin' }, { kind: 'lichess', key: 'bob' }] });
    const bob = h.sources.find(s => s.key === 'bob')!;
    expect(jobOf(bob.id)).toMatchObject({ status: 'queued', lane: 'lichess' });
    const removed = await req(owner, 'DELETE', `/api/profiles/${h.slug}/sources/${bob.id}`);
    expect(removed.statusCode, removed.body).toBe(200);
    expect(jobOf(bob.id)).toMatchObject({ status: 'cancelled', lane: 'lichess' });

    const added = await req(owner, 'POST', `/api/profiles/${h.slug}/sources`, { kind: 'chesscom', key: 'hikaru' });
    expect(added.statusCode, added.body).toBe(200);
    const hikaru = added.json<ProfileHeader>().sources.find(s => s.key === 'hikaru')!;
    expect(hikaru.id).toBeGreaterThan(bob.id);
    const job = jobOf(hikaru.id)!;
    expect(job).toMatchObject({ status: 'queued', lane: 'chesscom' });
    expect(JSON.parse(job.payload_json)).toEqual({ sourceId: hikaru.id });
    expect(hikaru.sync).toMatchObject({ state: 'queued', jobId: job.id });
  });

  it("leaves a running sync alone, which then can't touch another account", async () => {
    const h = await create(owner, { displayName: 'Runner', sources: [{ kind: 'lichess', key: 'fay' }, { kind: 'lichess', key: 'gus' }] });
    const gus = h.sources.find(s => s.key === 'gus')!;
    t.db.run("UPDATE jobs SET status = 'running', started_at = 1 WHERE dedupe_key = ?", [`sync:${gus.id}`]);
    // The queue position is the best one among the queued syncs (a running one is not "position 0").
    const header = (await req(owner, 'GET', `/api/profiles/${h.slug}`)).json<ProfileHeader>();
    const fay = header.sources.find(s => s.key === 'fay')!;
    expect(header.sources.find(s => s.key === 'gus')!.sync).toMatchObject({ state: 'running', queuePosition: 0 });
    expect(fay.sync.queuePosition).toBeGreaterThan(0);
    expect(header.queue).toEqual({ busy: true, cooldownUntil: null, queuePosition: fay.sync.queuePosition });
    const status = await req(owner, 'GET', `/api/profiles/${h.slug}/status`);
    expect(status.json().queue.queuePosition).toBe(fay.sync.queuePosition);
    expect((await req(owner, 'DELETE', `/api/profiles/${h.slug}/sources/${gus.id}`)).statusCode).toBe(200);
    expect(jobOf(gus.id)!.status).toBe('running');
    // What the running sync still does: its writes by id hit nothing, the games it stores
    // reference no source and are collected by the sweep.
    expect(t.db.run('UPDATE sources SET last_synced_at = 1 WHERE id = ?', [gus.id]).changes).toBe(0);
    const late = insertGame(t.db, testGame({ white: { name: 'gus' }, black: { name: 'stranger' } }));
    expect(late.sourceIds).toEqual([]);
    const kept = insertGame(t.db, testGame({ white: { name: 'gus' }, black: { name: 'fay' } }));
    const swept = await sweepOrphans(t.db, { scanGames: true });
    expect(swept.sources).toBe(0);
    expect(t.db.value('SELECT COUNT(*) FROM games WHERE id = ?', [late.gameId])).toBe(0);
    expect(t.db.value('SELECT COUNT(*) FROM positions WHERE game_id = ?', [late.gameId])).toBe(0);
    expect(t.db.value('SELECT COUNT(*) FROM games WHERE id = ?', [kept.gameId])).toBe(1);
  });

  it('cancels the queued syncs of a deleted profile, so they no longer count in other queues', async () => {
    const doomed = await create(owner, { displayName: 'Doomed', sources: [{ kind: 'lichess', key: 'hal' }] });
    const hal = doomed.sources[0]!.id;
    const survivor = await create(owner, { displayName: 'Survivor', sources: [{ kind: 'lichess', key: 'ida' }] });
    const before = survivor.sources[0]!.sync.queuePosition!;
    expect((await req(owner, 'DELETE', `/api/profiles/${doomed.slug}`)).statusCode).toBe(200);
    expect(jobOf(hal)!.status).toBe('cancelled');
    const after = (await req(owner, 'GET', `/api/profiles/${survivor.slug}`)).json<ProfileHeader>();
    expect(after.sources[0]!.sync.queuePosition).toBe(before - 1);
  });

  it('applies the policy to profiles deleted with their owner', async () => {
    const leaver = createUserSession(t.db, { username: 'leaver' });
    const keeper = createUserSession(t.db, { username: 'keeper' });
    t.db.run("INSERT INTO sources (kind, key, display_name, created_at) VALUES ('lichess', 'solo', 'solo', 0)");
    t.db.run("INSERT INTO sources (kind, key, display_name, created_at) VALUES ('lichess', 'shared', 'shared', 0)");
    const solo = t.db.value<number>("SELECT id FROM sources WHERE key = 'solo'")!;
    const shared = t.db.value<number>("SELECT id FROM sources WHERE key = 'shared'")!;
    const profile = (user: number, slug: string, sources: number[]) => {
      const id = t.db.run("INSERT INTO profiles (slug, display_name, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, 0, 0)", [slug, slug, user])
        .lastInsertRowid;
      for (const s of sources) t.db.run('INSERT INTO profile_sources (profile_id, source_id) VALUES (?, ?)', [id, s]);
    };
    profile(leaver.userId, 'leaver-1', [solo, shared]);
    profile(keeper.userId, 'keeper-1', [shared]);
    const soloGame = insertGame(t.db, testGame({ white: { name: 'solo' }, black: { name: 'random' } }));
    const sharedGame = insertGame(t.db, testGame({ white: { name: 'solo' }, black: { name: 'shared' } }));
    t.db.run("INSERT INTO jobs (kind, lane, payload_json, created_at, dedupe_key) VALUES ('sync', 'lichess', ?, 0, ?)", [
      JSON.stringify({ sourceId: solo }),
      `sync:${solo}`,
    ]);

    t.db.run('DELETE FROM users WHERE id = ?', [leaver.userId]);
    const r = await sweepOrphans(t.db);
    expect(r).toEqual({ sources: 1, games: 1 });
    expect(t.db.value('SELECT COUNT(*) FROM sources WHERE id = ?', [solo])).toBe(0);
    expect(t.db.value('SELECT COUNT(*) FROM sources WHERE id = ?', [shared])).toBe(1);
    expect(t.db.value('SELECT COUNT(*) FROM games WHERE id = ?', [soloGame.gameId])).toBe(0);
    expect(t.db.value('SELECT COUNT(*) FROM games WHERE id = ?', [sharedGame.gameId])).toBe(1);
    expect(jobOf(solo)!.status).toBe('cancelled');
    // Nothing left to do.
    expect(await sweepOrphans(t.db, { scanGames: true })).toEqual({ sources: 0, games: 0 });
  });

  it('scans for unreferenced games in windows and stops when asked', async () => {
    const ids = Array.from({ length: 12 }, () => insertGame(t.db, testGame({ white: { name: 'ghost' }, black: { name: 'phantom' } })).gameId);
    const db = t.db.run("INSERT INTO databases (name, kind, created_at) VALUES ('Keep', 'games', 0)").lastInsertRowid;
    const inDb = insertGame(t.db, testGame({ origin: 'pgn', originId: `${db}:x`, databaseId: db })).gameId;
    const stopped = new AbortController();
    stopped.abort();
    expect(await collectUnreferencedGames(t.db, stopped.signal)).toBe(0);
    expect(await collectUnreferencedGames(t.db)).toBe(ids.length);
    expect(t.db.value('SELECT COUNT(*) FROM games WHERE id = ?', [inDb])).toBe(1);
  });

  it('re-creates a reused source that vanished while its checks ran', () => {
    t.db.run("INSERT INTO sources (kind, key, display_name, created_at) VALUES ('lichess', 'vanishing', 'Vanishing', 0)");
    const id = t.db.value<number>("SELECT id FROM sources WHERE key = 'vanishing'")!;
    const resolved: ResolvedSource = {
      kind: 'lichess',
      key: 'vanishing',
      displayName: 'Vanishing',
      siteUserId: 'vanishing',
      title: null,
      country: null,
      databaseId: null,
      profileJson: null,
      existingId: id,
    };
    expect(insertSource(t.db, resolved)).toEqual({ id, created: false });
    t.db.run('DELETE FROM sources WHERE id = ?', [id]);
    const again = insertSource(t.db, resolved);
    expect(again.created).toBe(true);
    expect(again.id).toBeGreaterThan(id);
    // A pgn source whose database went away meanwhile is a validation error, not a crash.
    expect(() => insertSource(t.db, { ...resolved, kind: 'pgn', key: '987654:x', databaseId: 987654, existingId: null })).toThrow(/not found/);
  });
});
