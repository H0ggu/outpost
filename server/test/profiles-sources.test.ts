import type { ProfileHeader } from '@outpost/shared/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertGame } from '../src/chess/store.ts';
import { collectOrphanGames } from '../src/profiles/service.ts';
import { chesscomDisplayName, fideRatings, snapshotRatings, sourceUrl } from '../src/profiles/sources.ts';
import { createUserSession, makeTestApp, mutationHeaders, testGame, type TestApp } from './helpers.ts';
import { fakeUpstream, json, networkDown } from './fixtures/profiles/upstream.ts';

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

  it('accepts a FIDE id known to the FIDE directory, rejects unknown ids', async () => {
    const res = await create({ displayName: 'Sam', sources: [{ kind: 'fide', key: '1000001' }] });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<ProfileHeader>().sources[0]).toMatchObject({
      displayName: 'Synthetic, Sam',
      title: 'IM',
      gameCount: 0,
      fide: { standard: 2450, rapid: 2400, blitz: null },
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
