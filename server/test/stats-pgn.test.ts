import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API_ROUTES } from '@outpost/shared/api';
import { insertGame, parsePgnGames, type PgnGame } from '../src/chess/index.ts';
import { gameToPgn, pgnMovetext, terminationTag, type PgnGameRecord } from '../src/stats/pgnWriter.ts';
import { prepareProfilePgnExport } from '../src/stats/pgnExport.ts';
import { createSource, createUserSession, makeTestApp, testGame, type TestApp } from './helpers.ts';
import { createProfile, get, RUY, seedAliceWorld, type AliceWorld } from './stats-fixtures.ts';

const games = async (text: string): Promise<PgnGame[]> => {
  const out: PgnGame[] = [];
  for await (const g of parsePgnGames(text)) out.push(g);
  return out;
};
const tag = (g: PgnGame, k: string) => g.headers.get(k);

describe('PGN writer', () => {
  const record = (over: Partial<PgnGameRecord> = {}): PgnGameRecord => ({
    id: 1,
    origin: 'chesscom',
    url: 'https://www.chess.com/game/live/1',
    white: 'w',
    black: 'b',
    white_rating: 1200,
    black_rating: null,
    white_title: null,
    black_title: 'IM',
    white_fide_id: null,
    black_fide_id: null,
    result: '1/2-1/2',
    termination: 'timeout_vs_insufficient',
    time_class: 'bullet',
    time_control: '60+1',
    rated: 0,
    event: null,
    round: null,
    started_at: Date.UTC(2024, 1, 29, 23, 59, 58),
    ended_at: Date.UTC(2024, 2, 1, 0, 1, 0),
    moves_san: 'e4 e5',
    eco: null,
    opening_name: null,
    headers_json: null,
    ...over,
  });

  it('writes the roster, the facts and the movetext', () => {
    const text = gameToPgn(record());
    expect(text.split('\n\n')[0]!.split('\n')).toEqual([
      '[Event "Casual Bullet game"]',
      '[Site "https://www.chess.com/game/live/1"]',
      '[Date "2024.02.29"]',
      '[Round "-"]',
      '[White "w"]',
      '[Black "b"]',
      '[Result "1/2-1/2"]',
      '[UTCDate "2024.02.29"]',
      '[UTCTime "23:59:58"]',
      '[WhiteElo "1200"]',
      '[BlackTitle "IM"]',
      '[TimeControl "60+1"]',
      '[Termination "Time forfeit"]',
    ]);
    expect(text.endsWith('\n\n1. e4 e5 1/2-1/2\n')).toBe(true);
  });

  it('wraps long movetext at 80 columns', () => {
    const sans = Array.from({ length: 120 }, (_, i) => (i % 2 ? 'Nf6' : 'Nf3'));
    const text = pgnMovetext(sans.join(' '), '1-0');
    const lines = text.split('\n');
    expect(lines.length).toBeGreaterThan(5);
    expect(lines.every(l => l.length <= 80)).toBe(true);
    expect(lines.join(' ').split(' ').filter(x => /^\d+\.$/.test(x))).toHaveLength(60);
    expect(text.endsWith('1-0')).toBe(true);
  });

  it('maps terminations to the tag vocabulary', () => {
    expect(terminationTag('resign')).toBe('Normal');
    expect(terminationTag('timeout')).toBe('Time forfeit');
    expect(terminationTag('abandon')).toBe('Abandoned');
    expect(terminationTag('other')).toBeNull();
  });

  it('survives hostile names and corrupt stored headers', async () => {
    const text = gameToPgn(
      record({ white: 'O"Brien \\ Jr\n[Evil "x"]', headers_json: '{not json', origin: 'pgn', url: null }),
      { names: { black: 'Profile "Name"' } },
    );
    const [g] = await games(text);
    expect(tag(g!, 'White')).toBe('O"Brien \\ Jr [Evil "x"]');
    expect(tag(g!, 'Black')).toBe('Profile "Name"');
    expect(tag(g!, 'Evil')).toBeUndefined();
    expect(tag(g!, 'Site')).toBe('?');
  });
});

describe('GET /api/profiles/:slug/games.pgn', () => {
  let t: TestApp;
  let w: AliceWorld;

  beforeAll(async () => {
    t = await makeTestApp();
    w = seedAliceWorld(t);
    // alice (A) against her own hidden alt account (H): one game, both sides the profile's.
    insertGame(t.db, testGame({ startedAt: w.now - 7_200_000, endedAt: w.now - 3_600_000, white: { name: 'alice' }, black: { name: 'alice_alt' }, result: '0-1' }));
  });
  afterAll(async () => t.close());

  it('streams the filtered games newest first with the profile name normalised', async () => {
    const res = await get(t, API_ROUTES.stats.gamesPgn('alice'), w.users.other.cookie);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/x-chess-pgn; charset=utf-8');
    expect(res.headers['content-disposition']).toBe('attachment; filename="alice.pgn"');
    expect(res.headers['x-outpost-total']).toBe('6');
    expect(res.headers['x-outpost-exported']).toBe('6');
    const list = await games(res.text);
    expect(list).toHaveLength(6);
    expect(list.map(g => `${tag(g, 'White')} - ${tag(g, 'Black')}`)).toEqual([
      'Alice Liddell - alice_alt', // the hidden account keeps its name for other viewers
      'Alice Liddell - bob',
      'carol - Alice Liddell',
      'Alice Liddell - dave',
      'bob - Alice Liddell',
      'Alice Liddell - carol',
    ]);
    expect([...list[1]!.moves.mainline()].map(n => n.san)).toEqual(RUY);
    expect(tag(list[3]!, 'Event')).toBe('Casual Bullet game');
    expect(tag(list[4]!, 'Event')).toBe('Titled Tuesday');
  });

  it('writes a game between two of the profile accounts once, both sides normalised', async () => {
    const from = new Date(w.now - 86_400_000).toISOString().slice(0, 10);
    const res = await get(t, `${API_ROUTES.stats.gamesPgn('alice')}?from=${from}`, w.users.owner.cookie);
    const list = await games(res.text);
    expect(res.headers['x-outpost-total']).toBe('2');
    expect(list.map(g => `${tag(g, 'White')} - ${tag(g, 'Black')}`)).toEqual(['Alice Liddell - Alice Liddell', 'Alice Liddell - bob']);
  });

  it('applies filters and access rules', async () => {
    const black = await games((await get(t, `${API_ROUTES.stats.gamesPgn('alice')}?color=black`, w.users.other.cookie)).text);
    expect(black.map(g => tag(g, 'Black'))).toEqual(['Alice Liddell', 'Alice Liddell']);
    expect((await get(t, API_ROUTES.stats.gamesPgn('private-p'), w.users.other.cookie)).status).toBe(404);
    expect((await get(t, API_ROUTES.stats.gamesPgn('alice'))).status).toBe(401);
    expect((await get(t, `${API_ROUTES.stats.gamesPgn('alice')}?outcome=x`, w.users.other.cookie)).status).toBe(400);
  });

  it('stops at the export limit, keeping the newest games', () => {
    const exp = prepareProfilePgnExport({ db: t.db, sourceIds: [w.src.A, w.src.C], filters: {} }, 'Alice', 3);
    expect(exp).toMatchObject({ total: 6, exported: 3 });
    const text = [...exp.chunks()].join('');
    expect(text.match(/^\[Event /gm)).toHaveLength(3);
    expect(text.indexOf('Black "alice_alt"')).toBeLessThan(text.indexOf('Black "bob"'));
  });
});

describe('PGN export in batches', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await makeTestApp();
    const src = createSource(t.db, { kind: 'lichess', key: 'bulk' });
    createProfile(t.db, { slug: 'bulk', displayName: 'Bulk Player', ownerUserId: null, sources: [{ id: src }] });
    t.db.tx(() => {
      for (let i = 0; i < 620; i++) {
        insertGame(t.db, testGame({ endedAt: Date.UTC(2025, 0, 1) + i * 60_000, white: { name: i % 2 ? 'bulk' : `opp${i}` }, black: { name: i % 2 ? `opp${i}` : 'bulk' } }));
      }
    });
  });
  afterAll(async () => t.close());

  it('streams several chunks that parse back to every game', async () => {
    const exp = prepareProfilePgnExport({ db: t.db, sourceIds: [1], filters: {} }, 'Bulk Player');
    expect([...exp.chunks()].length).toBe(3);
    const cookie = createUserSession(t.db, { username: 'v' }).cookie;
    const res = await get(t, API_ROUTES.stats.gamesPgn('bulk'), cookie);
    const list = await games(res.text);
    expect(list).toHaveLength(620);
    expect(list.every(g => tag(g, 'White') === 'Bulk Player' || tag(g, 'Black') === 'Bulk Player')).toBe(true);
    expect(tag(list[0]!, 'Black')).toBe('opp619');
    expect(tag(list.at(-1)!, 'White')).toBe('opp0');
  });
});

describe('PGN export transport', () => {
  let t: TestApp;
  let cookie: string;

  beforeAll(async () => {
    t = await makeTestApp();
    const src = createSource(t.db, { kind: 'lichess', key: 'zipper' });
    createProfile(t.db, { slug: 'zipper', displayName: 'Zip Player', ownerUserId: null, sources: [{ id: src }] });
    t.db.tx(() => {
      for (let i = 0; i < 300; i++) {
        insertGame(t.db, testGame({ endedAt: Date.UTC(2025, 0, 1) + i * 60_000, white: { name: 'zipper' }, black: { name: `opp${i}` }, moves: RUY }));
      }
    });
    cookie = createUserSession(t.db, { username: 'zip-viewer' }).cookie;
  });
  afterAll(async () => t.close());

  it.each([
    ['gzip', gunzipSync],
    ['br', brotliDecompressSync],
  ] as const)('compresses the stream with %s', async (encoding, decompress) => {
    const res = await t.app.inject({ method: 'GET', url: API_ROUTES.stats.gamesPgn('zipper'), headers: { cookie, 'accept-encoding': encoding } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-encoding']).toBe(encoding);
    const text = decompress(res.rawPayload).toString('utf8');
    expect(res.rawPayload.length).toBeLessThan(text.length / 4);
    const list = await games(text);
    expect(list).toHaveLength(300);
    expect(list.every(g => tag(g, 'White') === 'Zip Player')).toBe(true);
  });

  it('sends plain text to clients without compression', async () => {
    const res = await t.app.inject({ method: 'GET', url: API_ROUTES.stats.gamesPgn('zipper'), headers: { cookie } });
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.body.startsWith('[Event "Rated Blitz game"]')).toBe(true);
  });

  it('limits exports per client', async () => {
    // Earlier tests in this block used 3 of the 20 per minute.
    const statuses: number[] = [];
    for (let i = 0; i < 20; i++) {
      statuses.push((await t.app.inject({ method: 'GET', url: `${API_ROUTES.stats.gamesPgn('zipper')}?period=24h`, headers: { cookie } })).statusCode);
    }
    expect(statuses.slice(0, 17).every(s => s === 200)).toBe(true);
    expect(statuses.slice(17)).toEqual([429, 429, 429]);
    const res = await get<{ error: { code: string } }>(t, API_ROUTES.stats.gamesPgn('zipper'), cookie);
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('rate_limited');
    // Other stats routes have their own budget.
    expect((await get(t, API_ROUTES.stats.games('zipper'), cookie)).status).toBe(200);
  });
});
