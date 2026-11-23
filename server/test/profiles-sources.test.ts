import type { ProfileHeader, ProfileListResponse } from '@outpost/shared/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertGame, rebuildPlayerGames } from '../src/chess/store.ts';
import { HttpError } from '../src/http/errors.ts';
import type { AuthUser } from '../src/http/types.ts';
import { collectOrphanGames, summaryRatings } from '../src/profiles/service.ts';
import { chesscomDisplayName, fideRatings, resolveSource, snapshotRatings, sourceUrl } from '../src/profiles/sources.ts';
import { createUserSession, makeTestApp, mutationHeaders, testGame, type TestApp } from './helpers.ts';
import { fakeUpstream, json, networkDown, stalledJson } from './fixtures/profiles/upstream.ts';

type Session = { userId: number; cookie: string };

describe('FIDE sources and source helpers', () => {
  let t: TestApp;
  let up: ReturnType<typeof fakeUpstream>;
  let me: Session;
  let refDb: number;

  const create = (body: unknown) =>
    t.app.inject({ method: 'POST', url: '/api/profiles', headers: { ...mutationHeaders, cookie: me.cookie }, payload: body as object });

  beforeAll(async () => {
    up = fakeUpstream({
      'GET lichess.org/api/fide/player/1000001': () =>
        json({ id: 1000001, name: 'Synthetic, Sam', title: 'IM', federation: 'NOR', year: 1990, standard: 2450, rapid: 2400, blitz: null }),
    });
    t = await makeTestApp({ fetch: up.fetch });
    me = createUserSession(t.db, { username: 'me' });
    refDb = t.db.run("INSERT INTO databases (name, kind, visibility, created_at) VALUES ('Broadcasts', 'reference', 'public', 0)").lastInsertRowid;
    for (const [i, result] of (['1-0', '0-1', '1/2-1/2'] as const).entries()) {
      insertGame(
        t.db,
        testGame({
          origin: 'reference',
          originId: `${refDb}:ref${i}`,
          databaseId: refDb,
          result,
          white: { name: 'Example, Erik', fideId: '2000002', title: 'GM', rating: 2600 },
          black: { name: `Opponent ${i}`, fideId: `300000${i}` },
          timeClass: 'classical',
          rated: true,
        }),
      );
    }
  });
  afterAll(async () => t.close());

  it('creates a FIDE source from reference games and picks up their player_games', async () => {
    const res = await create({ displayName: 'Erik', sources: [{ kind: 'fide', key: '2000002' }] });
    expect(res.statusCode, res.body).toBe(200);
    const h = res.json<ProfileHeader>();
    expect(up.calls).toEqual(['GET lichess.org/api/fide/player/2000002']);
    expect(h.sources[0]).toMatchObject({
      kind: 'fide',
      key: '2000002',
      displayName: 'Example, Erik',
      title: 'GM',
      url: 'https://ratings.fide.com/profile/2000002',
      gameCount: 3,
      fide: null,
      sync: { state: 'idle' },
    });
    expect(h.totals).toEqual({ w: 1, d: 1, l: 1, games: 3 });
    expect(h.sources[0]!.ratings).toEqual([{ timeClass: 'classical', rating: 2600, games: 3, rd: null, provisional: false }]);
    expect(t.db.value("SELECT COUNT(*) FROM jobs WHERE kind = 'sync'")).toBe(0);
  });

  it('gives profile lists the ratings of each time class, most played first', async () => {
    // The FIDE profile above: three classical reference games at 2600.
    const list = (await t.app.inject({ url: '/api/profiles?scope=mine', headers: { cookie: me.cookie } })).json<ProfileListResponse>();
    expect(list.profiles.find(p => p.displayName === 'Erik')?.ratings).toEqual([{ kind: 'fide', timeClass: 'classical', rating: 2600, games: 3 }]);
    // Site snapshots without stored games: per time class the better-known account (games, then rating).
    const lichess = {
      id: 990_001,
      kind: 'lichess' as const,
      profile_json: JSON.stringify({ perfs: { bullet: { rating: 2650, games: 10 }, blitz: { rating: 2500, games: 40 }, rapid: { rating: 2400, games: 0 } } }),
    };
    const chesscom = { id: 990_002, kind: 'chesscom' as const, profile_json: JSON.stringify({ stats: { chess_blitz: { last: { rating: 2550 } } } }) };
    expect(summaryRatings(t.db, [lichess, chesscom])).toEqual([
      { kind: 'lichess', timeClass: 'bullet', rating: 2650, games: 0 },
      { kind: 'chesscom', timeClass: 'blitz', rating: 2550, games: 0 },
    ]);
    expect(summaryRatings(t.db, [])).toEqual([]);
  });

  it('accepts a FIDE id known to the FIDE directory, rejects unknown ids', async () => {
    const res = await create({ displayName: 'Sam', sources: [{ kind: 'fide', key: '1000001' }] });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<ProfileHeader>().sources[0]).toMatchObject({
      displayName: 'Synthetic, Sam',
      title: 'IM',
      gameCount: 0,
      fide: { standard: 2450, rapid: 2400, blitz: null },
      country: 'NO', // the FIDE directory's federation NOR
    });
    const unknown = await create({ displayName: 'Nobody', sources: [{ kind: 'fide', key: '999' }] });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error.message).toBe('Unknown FIDE id 999');
    expect((await create({ displayName: 'Bad', sources: [{ kind: 'fide', key: '12ab' }] })).statusCode).toBe(400);
  });

  it('needs the FIDE directory only when no local games know the id', async () => {
    up.routes['GET lichess.org/api/fide/player/3000001'] = networkDown;
    up.routes['GET lichess.org/api/fide/player/4000004'] = networkDown;
    const local = await create({ displayName: 'Opp', sources: [{ kind: 'fide', key: '3000001' }] });
    expect(local.statusCode, local.body).toBe(200);
    expect(local.json<ProfileHeader>().sources[0]).toMatchObject({ displayName: 'Opponent 1', gameCount: 1 });
    const down = await create({ displayName: 'Down', sources: [{ kind: 'fide', key: '4000004' }] });
    expect(down.statusCode).toBe(503);
  });

  it("never attaches games of user PGN databases to a FIDE source (someone's private DB stays private)", async () => {
    const alice = createUserSession(t.db, { username: 'alice' });
    const mallory = createUserSession(t.db, { username: 'mallory' });
    const privateDb = t.db
      .run("INSERT INTO databases (owner_user_id, name, kind, visibility, created_at) VALUES (?, 'Secrets', 'games', 'private', 0)", [alice.userId])
      .lastInsertRowid;
    const privateGame = (n: number) =>
      testGame({
        origin: 'pgn',
        originId: `${privateDb}:secret${n}`,
        databaseId: privateDb,
        event: 'Secret training match',
        result: n % 2 ? '1-0' : '1/2-1/2',
        white: { name: 'Alice Private', fideId: '99999999' },
        black: { name: `Sparring ${n}`, fideId: '88888888' },
      });
    insertGame(t.db, privateGame(1));
    insertGame(t.db, privateGame(2));

    // Unknown to the reference DB and to the FIDE directory: the private games don't vouch for it.
    const asMallory = (body: unknown) =>
      t.app.inject({ method: 'POST', url: '/api/profiles', headers: { ...mutationHeaders, cookie: mallory.cookie }, payload: body as object });
    const unknown = await asMallory({ displayName: 'Probe', visibility: 'public', sources: [{ kind: 'fide', key: '99999999' }] });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error.message).toBe('Unknown FIDE id 99999999');

    // Known to the directory: the profile is created, but without the private games or their name.
    up.routes['GET lichess.org/api/fide/player/99999999'] = () => json({ id: 99999999, name: 'Directory, Name', federation: 'FID' });
    const res = await asMallory({ displayName: 'Probe', visibility: 'public', sources: [{ kind: 'fide', key: '99999999' }] });
    expect(res.statusCode, res.body).toBe(200);
    const h = res.json<ProfileHeader>();
    expect(h.sources[0]).toMatchObject({ displayName: 'Directory, Name', gameCount: 0 });
    expect(h.totals).toEqual({ w: 0, d: 0, l: 0, games: 0 });
    const fideSource = h.sources[0]!.id;

    // Later imports into the private DB and manual updates don't attach them either.
    insertGame(t.db, privateGame(3));
    const update = await t.app.inject({
      method: 'POST',
      url: `/api/profiles/${h.slug}/update`,
      headers: { ...mutationHeaders, cookie: mallory.cookie },
    });
    expect(update.statusCode, update.body).toBe(200);
    expect(rebuildPlayerGames(t.db, fideSource)).toBe(0);
    expect(t.db.value('SELECT COUNT(*) FROM player_games WHERE source_id = ?', [fideSource])).toBe(0);
    expect((await t.app.inject({ url: `/api/profiles/${h.slug}`, headers: { cookie: mallory.cookie } })).json<ProfileHeader>().totals.games).toBe(0);

    // Reference games of the same id still count.
    insertGame(
      t.db,
      testGame({
        origin: 'reference',
        originId: `${refDb}:fide-probe`,
        databaseId: refDb,
        white: { name: 'Directory, Name', fideId: '99999999' },
        black: { name: 'Someone', fideId: '3000009' },
      }),
    );
    expect(t.db.value('SELECT COUNT(*) FROM player_games WHERE source_id = ?', [fideSource])).toBe(1);
  });

  it('gives up on an account check whose answer stalls mid-body', async () => {
    up.routes['GET lichess.org/api/user/staller'] = () => stalledJson();
    const started = Date.now();
    const err = await resolveSource(
      { db: t.db, upstream: t.app.upstream, viewer: { id: me.userId, username: 'me', role: 'user', totpEnabled: false, prefs: {} } as AuthUser, timeoutMs: 100 },
      { kind: 'lichess', key: 'staller' },
    ).catch((e: unknown) => e);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ statusCode: 503, code: 'upstream_unavailable', details: { reason: 'timeout' } });
  });

  it('reads rating snapshots in the shapes the sync may store', () => {
    const lichess = { perfs: { blitz: { games: 3, rating: 2001.4, rd: 45, prov: true }, bullet: { games: 0, rating: 1500 } }, profile: { fideRating: 2100 } };
    expect([...snapshotRatings('lichess', JSON.stringify(lichess))]).toEqual([['blitz', { rating: 2001, rd: 45, provisional: true }]]);
    expect([...snapshotRatings('lichess', JSON.stringify({ user: lichess }))].length).toBe(1);
    expect(fideRatings('lichess', JSON.stringify({ user: lichess }))).toEqual({ standard: 2100, rapid: null, blitz: null });
    const stats = { chess_daily: { last: { rating: 1900, rd: 80 } }, chess_rapid: { last: { rating: 2000 } }, fide: 0 };
    expect([...snapshotRatings('chesscom', JSON.stringify(stats)).keys()]).toEqual(['rapid', 'correspondence']);
    expect([...snapshotRatings('chesscom', JSON.stringify({ player: {}, stats })).keys()]).toEqual(['rapid', 'correspondence']);
    expect(fideRatings('chesscom', JSON.stringify(stats))).toBeNull();
    expect(snapshotRatings('lichess', 'not json').size).toBe(0);
    expect(snapshotRatings('fide', JSON.stringify(lichess)).size).toBe(0);
    expect(sourceUrl('chesscom', 'hikaru', 'Hikaru')).toBe('https://www.chess.com/member/Hikaru');
    expect(sourceUrl('pgn', '1:x', 'x')).toBeNull();
    expect(chesscomDisplayName('https://www.chess.com/member/Hikaru', 'hikaru')).toBe('Hikaru');
    expect(chesscomDisplayName('https://www.chess.com/member/%E0%A4%A', 'hikaru')).toBe('hikaru');
    expect(chesscomDisplayName('https://www.chess.com/member/Someone', 'hikaru')).toBe('hikaru');
    expect(chesscomDisplayName(undefined, 'hikaru')).toBe('hikaru');
  });

  it('collects orphaned games in batches, keeping referenced and database games', async () => {
    const lone = insertGame(t.db, testGame({ white: { name: 'nobody1' }, black: { name: 'nobody2' } }));
    const ref = t.db.value<number>('SELECT id FROM games WHERE database_id = ? LIMIT 1', [refDb])!;
    t.db.run("INSERT INTO sources (kind, key, display_name, created_at) VALUES ('lichess', 'tracked', 'tracked', 0)");
    const tracked = insertGame(t.db, testGame({ white: { name: 'tracked' }, black: { name: 'nobody3' } }));
    expect(tracked.sourceIds).toHaveLength(1);
    const n = await collectOrphanGames(t.db, [lone.gameId, ref, tracked.gameId, 123456789]);
    expect(n).toBe(1);
    expect(t.db.value('SELECT COUNT(*) FROM games WHERE id IN (?, ?, ?)', [lone.gameId, ref, tracked.gameId])).toBe(2);
    // Larger sets go in several batches.
    const many = Array.from({ length: 600 }, () => insertGame(t.db, testGame({ white: { name: 'x' }, black: { name: 'y' } })).gameId);
    expect(await collectOrphanGames(t.db, many)).toBe(600);
  });
});
