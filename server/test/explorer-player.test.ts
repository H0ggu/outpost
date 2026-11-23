import type { ExplorerPlayerResponse, Id } from '@outpost/shared/api';
import { encodeFiltersSegment, type ProfileFilters } from '@outpost/shared/filters';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertGame, pgnSourceKey } from '../src/chess/store.ts';
import { fideDp, performanceRating } from '../src/explorer/responses.ts';
import { writeSettings } from '../src/settings.ts';
import { createDatabase, createProfile, expectSameShape, fixtureText, lastNdjsonLine, sans } from './explorer-support.ts';
import { createSource, createUserSession, makeTestApp, testGame, type TestApp } from './helpers.ts';

const month = (m: number): number => Date.UTC(2026, m - 1, 15, 12);

describe('player explorer (/api/explorer/player)', () => {
  let t: TestApp;
  let owner: string;
  let other: string;
  let admin: string;
  const ids: Record<string, Id> = {};
  let gamesDb: Id;
  let refDb: Id;

  beforeAll(async () => {
    t = await makeTestApp();
    const db = t.db;
    owner = createUserSession(db, { username: 'olga' }).cookie;
    const ownerId = db.value<Id>("SELECT id FROM users WHERE username = 'olga'")!;
    other = createUserSession(db, { username: 'oscar' }).cookie;
    admin = createUserSession(db, { username: 'ada', role: 'admin' }).cookie;

    // Public, so the profile's PGN source counts for every viewer (a private database's games count
    // for its owner and admins only: see 'reads db:<id>' below).
    gamesDb = createDatabase(db, { name: 'olga games', kind: 'games', ownerId, visibility: 'public' });
    refDb = createDatabase(db, { name: 'Reference', kind: 'reference' });
    const sA = createSource(db, { kind: 'lichess', key: 'alice' });
    const sC = createSource(db, { kind: 'chesscom', key: 'alicecc' });
    const sP = createSource(db, { kind: 'lichess', key: 'carol' });
    const sG = createSource(db, { kind: 'pgn', key: pgnSourceKey(gamesDb, 'Alice Smith'), databaseId: gamesDb });
    createProfile(db, { slug: 'alice', ownerId, visibility: 'public', sources: [{ id: sA }, { id: sC, hidden: true }, { id: sG }] });
    createProfile(db, { slug: 'secret', ownerId, visibility: 'private', sources: [{ id: sP }] });

    const g = (key: string, over: Parameters<typeof testGame>[0]) => {
      ids[key] = insertGame(db, testGame(over)).gameId;
    };
    const at = (m: number) => ({ startedAt: month(m) - 600_000, endedAt: month(m) });
    // Alice (lichess) as White.
    g('g1', { ...at(1), moves: sans('e4 e5 Nf3 Nc6 Bb5 a6'), result: '1-0', black: { name: 'bob', rating: 1500 } });
    g('g2', { ...at(2), moves: sans('e4 e5 Nf3 Nc6 Bb5 Nf6'), result: '1-0', black: { name: 'bob', rating: 1700 } });
    g('g3', { ...at(3), moves: sans('e4 c5'), result: '0-1', timeClass: 'rapid', black: { name: 'dave', rating: 1600 } });
    g('g4', { ...at(4), moves: sans('d4 d5'), result: '1/2-1/2', timeClass: 'bullet', rated: false, black: { name: 'eve', rating: 1400 } });
    g('g5', { ...at(5), moves: sans('Nf3 d5 d4 Nf6'), result: '1-0' });
    g('g6', { ...at(6), moves: sans('d4 d5 Nf3 e6'), result: '0-1' });
    g('g7', { ...at(7), moves: sans('Nf3 Nf6 Ng1 Ng8 Nf3 Nf6 Ng1 Ng8 e4 e5'), result: '1-0', timeClass: 'classical' });
    // Alice (lichess) as Black.
    g('g8', { ...at(8), moves: sans('e4 e5 Nf3 Nc6'), result: '1-0', white: { name: 'bob' }, black: { name: 'alice' } });
    // Alice's hidden Chess.com account.
    g('g9', { ...at(9), origin: 'chesscom', moves: sans('e4 e6'), result: '1-0', timeClass: 'rapid', white: { name: 'alicecc' } });
    // Carol (private profile).
    g('g10', { ...at(9), moves: sans('c4 e5'), white: { name: 'carol' } });
    // Alice Smith in Olga's (public) PGN database: no time class, unrated.
    g('g11', {
      ...at(10),
      origin: 'pgn',
      originId: `${gamesDb}:abc`,
      databaseId: gamesDb,
      moves: sans('c4 c5'),
      result: '1-0',
      timeClass: 'unknown',
      rated: false,
      white: { name: 'Alice Smith', rating: null },
      black: { name: 'Someone', rating: null },
    });
    // Reference games of a (synthetic) FIDE player.
    const ref = (key: string, m: number, moves: string, result: '1-0' | '0-1' | '1/2-1/2', white: boolean) =>
      g(key, {
        ...at(m),
        origin: 'reference',
        originId: `${refDb}:${key}`,
        databaseId: refDb,
        moves: sans(moves),
        result,
        timeClass: 'classical',
        white: white ? { name: 'Ref Player', rating: 2700, fideId: '99999901' } : { name: 'Other GM', rating: 2650 },
        black: white ? { name: 'Other GM', rating: 2650 } : { name: 'Ref Player', rating: 2700, fideId: '99999901' },
      });
    ref('r1', 1, 'e4 e5', '1-0', true);
    ref('r2', 2, 'd4 d5', '1/2-1/2', true);
    ref('r3', 3, 'e4 c5', '0-1', false);
  });

  afterAll(async () => {
    await t?.close();
  });

  const get = async (query: string, cookie: string | null = other, base = '/api/explorer/player') => {
    const res = await t.app.inject({ url: `${base}?${query}`, headers: cookie ? { cookie } : {} });
    return res;
  };
  const explore = async (query: string, cookie: string | null = other, base?: string): Promise<ExplorerPlayerResponse> => {
    const res = await get(query, cookie, base);
    expect(res.statusCode, res.body).toBe(200);
    return lastNdjsonLine<ExplorerPlayerResponse>(res.body);
  };
  const move = (r: ExplorerPlayerResponse, uci: string) => r.moves.find(m => m.uci === uci);

  it('answers one NDJSON line in the shape of the Lichess player explorer', async () => {
    const res = await get('player=alice&color=white&variant=standard&source=analysis');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/x-ndjson/);
    expect(res.body.endsWith('\n')).toBe(true);
    expect(res.body.trimEnd().split('\n')).toHaveLength(1);
    const body = lastNdjsonLine<ExplorerPlayerResponse>(res.body);
    const sample = lastNdjsonLine(fixtureText('lichess-player-sample.ndjson'));
    // Keys and types match what lila's OpeningData parses; moves[].game / opening may be null.
    expectSameShape(body, sample, { nullable: ['game', 'opening', 'winner'], optional: ['speed', 'title'] });
    expect(body.queuePosition).toBe(0);
    const withGame = body.moves.find(m => m.game !== null)!;
    const sampleGame = (sample as ExplorerPlayerResponse).moves.find(m => m.game !== null)!.game;
    expectSameShape(withGame.game, sampleGame, { nullable: ['winner'], optional: ['speed', 'title'] });
  });

  it('counts each game once at the start position, with absolute White/Draw/Black results', async () => {
    const r = await explore('player=alice&color=white');
    // Visible to others: g1–g7 (lichess) + g11 (pgn). Hidden Chess.com game g9 is not counted.
    expect(r.moves.map(m => [m.uci, m.san, m.white, m.draws, m.black])).toEqual([
      ['e2e4', 'e4', 2, 0, 1],
      ['g1f3', 'Nf3', 2, 0, 0],
      ['d2d4', 'd4', 0, 1, 1],
      ['c2c4', 'c4', 1, 0, 0],
    ]);
    expect([r.white, r.draws, r.black]).toEqual([5, 1, 2]);
    expect(r.opening).toBeNull();
    // The owner also sees the hidden account.
    const own = await explore('player=alice&color=white', owner);
    expect(move(own, 'e2e4')).toMatchObject({ white: 3, draws: 0, black: 1 });
    expect([own.white, own.draws, own.black]).toEqual([6, 1, 2]);
  });

  it('merges transpositions (1.Nf3 d5 2.d4 = 1.d4 d5 2.Nf3)', async () => {
    const r = await explore('player=alice&color=white&play=d2d4,d7d5,g1f3');
    expect(r.moves.map(m => [m.uci, m.white, m.draws, m.black])).toEqual([
      ['e7e6', 0, 0, 1],
      ['g8f6', 1, 0, 0],
    ]);
    expect(r.opening?.eco).toMatch(/^D0/);
    // Same position via the other move order and via fen.
    const viaNf3 = await explore('player=alice&color=white&play=g1f3,d7d5,d2d4');
    expect(viaNf3.moves).toEqual(r.moves);
    const fen = encodeURIComponent('rnbqkbnr/ppp1pppp/8/3p4/3P4/5N2/PPP1PPPP/RNBQKB1R b KQkq - 1 2');
    const viaFen = await explore(`player=alice&color=white&fen=${fen}`);
    expect(viaFen.moves.map(m => m.uci)).toEqual(['e7e6', 'g8f6']);
  });

  it('counts a game that repeats a position once, at its first occurrence', async () => {
    const r = await explore('player=alice&color=white&play=g1f3');
    // g5 (1…d5) and g7 (1…Nf6, twice before 5.e4) — g7 counts once.
    expect(r.moves.map(m => [m.uci, m.white + m.draws + m.black])).toEqual([
      ['g8f6', 1],
      ['d7d5', 1],
    ]);
    const start = await explore('player=alice&color=white');
    expect(move(start, 'g1f3')!.white).toBe(2);
  });

  it('leaves out games that ended at the position (Lichess counts moves)', async () => {
    const r = await explore('player=alice&color=white&play=e2e4,c7c5');
    expect(r.moves).toEqual([]);
    expect([r.white, r.draws, r.black]).toEqual([0, 0, 0]);
  });

  it("reads the player's colour", async () => {
    const r = await explore('player=alice&color=black');
    expect(r.moves.map(m => [m.uci, m.white, m.draws, m.black])).toEqual([['e2e4', 1, 0, 0]]);
    const after = await explore('player=alice&color=black&play=e2e4');
    expect(after.moves.map(m => [m.uci, m.san])).toEqual([['e7e5', 'e5']]);
  });

  it('computes averageOpponentRating and a FIDE performance rating', async () => {
    const r = await explore('player=alice&color=white');
    const e4 = move(r, 'e2e4')!;
    // g1 (W vs 1500), g2 (W vs 1700), g3 (L vs 1600).
    expect(e4.averageOpponentRating).toBe(1600);
    expect(e4.performance).toBe(1600 + fideDp(2 / 3));
    expect(e4.performance).toBe(1725);
    // The PGN game has no ratings: no average, no performance.
    expect(move(r, 'c2c4')).toMatchObject({ averageOpponentRating: 0, performance: 0 });
    expect(performanceRating(1500, 1)).toBe(2300);
    expect(performanceRating(1500, 0)).toBe(700);
    expect(performanceRating(1500, 0.5)).toBe(1500);
  });

  it('attaches a game ref only to moves played in exactly one game', async () => {
    const r = await explore('player=alice&color=white');
    expect(move(r, 'e2e4')!.game).toBeNull();
    const c4 = move(r, 'c2c4')!;
    expect(c4.game).toMatchObject({ id: `op${ids.g11}`, winner: 'white', mode: 'casual', year: 2026, month: '2026-10' });
    expect(c4.game).not.toHaveProperty('speed');
    expect(c4.game!.white).toEqual({ name: 'Alice Smith', rating: 0 });
    expect(c4.lastPlayed).toBe(month(10));
  });

  it('lists recent games (op ids, uci, speed, mode), newest first', async () => {
    const r = await explore('player=alice&color=white');
    expect(r.recentGames.map(g => g.id)).toEqual(['g11', 'g7', 'g6', 'g5', 'g4', 'g3', 'g2', 'g1'].map(k => `op${ids[k]}`));
    expect(r.recentGames[1]).toMatchObject({ uci: 'g1f3', winner: 'white', speed: 'classical', mode: 'rated' });
    expect(r.recentGames[4]).toMatchObject({ uci: 'd2d4', winner: null, speed: 'bullet', mode: 'casual' });
    expect(r.recentGames[1]!.white).toEqual({ name: 'alice', rating: 1500 });
    const few = await explore('player=alice&color=white&recentGames=2');
    expect(few.recentGames).toHaveLength(2);
    const none = await explore('player=alice&color=white&recentGames=0&topGames=0');
    expect(none.recentGames).toEqual([]);
  });

  it('names the opening along the line and per move', async () => {
    const r = await explore('player=alice&color=white&play=e2e4,e7e5,g1f3,b8c6,f1b5');
    expect(r.opening).toEqual({ eco: 'C60', name: 'Ruy Lopez' });
    expect(move(r, 'a7a6')!.opening).toEqual({ eco: 'C70', name: 'Ruy Lopez: Morphy Defense' });
    expect(move(r, 'a7a6')!.san).toBe('a6');
    // Leaving the book keeps the last name met on the way.
    const deeper = await explore('player=alice&color=white&play=e2e4,e7e5,g1f3,b8c6,f1b5,a7a6,h2h3');
    expect(deeper.opening?.name).toMatch(/^Ruy Lopez/);
  });

  it('applies the Outpost filters from the /f/<segment>/ path', async () => {
    const seg = (f: ProfileFilters) => `/api/explorer/f/${encodeFiltersSegment(f)}/player`;
    const rapid = await explore('player=alice&color=white', owner, seg({ tc: ['rapid'] }));
    expect(rapid.moves.map(m => [m.uci, m.white, m.black])).toEqual([['e2e4', 1, 1]]);
    const wins = await explore('player=alice&color=white', other, seg({ outcome: ['w'] }));
    expect([wins.white, wins.draws, wins.black]).toEqual([5, 0, 0]);
    const vsBob = await explore('player=alice&color=white', other, seg({ oppName: 'bob' }));
    expect(vsBob.white + vsBob.draws + vsBob.black).toBe(5);
    const line = await explore('player=alice&color=white', other, seg({ line: ['g1f3', 'd7d5', 'd2d4'] }));
    // g6 (1.d4, June) and g5 (1.Nf3, May) reach it: one game each, most recent first.
    expect(line.moves.map(m => m.uci)).toEqual(['d2d4', 'g1f3']);
    // The explorer's colour wins over a `color` filter.
    const colour = await explore('player=alice&color=black', other, seg({ color: 'white' }));
    expect(colour.moves.map(m => m.uci)).toEqual(['e2e4']);
    // `_` = no filters.
    const empty = await explore('player=alice&color=white', other, '/api/explorer/f/_/player');
    expect(empty.white).toBe(5);
    // Bad segments are a validation error.
    const bad = await get('player=alice&color=white', other, '/api/explorer/f/!!!/player');
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('validation');
    const badFilter = await get('player=alice&color=white', other, `/api/explorer/f/${Buffer.from('tc=hyper').toString('base64url')}/player`);
    expect(badFilter.statusCode).toBe(400);
  });

  it("ANDs lila's speeds/modes/since/until through explorerQueryRestrictions", async () => {
    const total = (r: ExplorerPlayerResponse) => r.white + r.draws + r.black;
    // lila's default (no ultraBullet) = no restriction: the PGN game (unknown time class) stays.
    const all = await explore('player=alice&color=white&speeds=bullet,blitz,rapid,classical,correspondence&modes=casual,rated');
    expect(total(all)).toBe(8);
    expect(move(all, 'c2c4')).toBeDefined();
    const bullet = await explore('player=alice&color=white&speeds=ultraBullet');
    expect(bullet.moves.map(m => [m.uci, m.draws])).toEqual([['d2d4', 1]]);
    const blitz = await explore('player=alice&color=white&speeds=blitz');
    expect(move(blitz, 'c2c4')).toBeUndefined();
    expect(total(blitz)).toBe(4);
    const rated = await explore('player=alice&color=white&modes=rated');
    expect(total(rated)).toBe(6);
    const casual = await explore('player=alice&color=white&modes=casual');
    expect(casual.moves.map(m => m.uci).sort()).toEqual(['c2c4', 'd2d4']);
    const since = await explore('player=alice&color=white&since=2026-05&until=2026-07');
    expect(total(since)).toBe(3);
    const year = await explore('player=alice&color=white&until=2025');
    expect(total(year)).toBe(0);
    // Malformed values are ignored, like lila's own settings.
    const junk = await explore('player=alice&color=white&speeds=hyper&modes=x&since=soon');
    expect(total(junk)).toBe(8);
  });

  it('accepts lichess:/chesscom: specs for visible local sources only', async () => {
    const r = await explore('player=lichess:Alice&color=white');
    expect(r.white + r.draws + r.black).toBe(7);
    expect((await get('player=chesscom:alicecc&color=white')).statusCode).toBe(404);
    const own = await explore('player=chesscom:alicecc&color=white', owner);
    expect(own.moves.map(m => [m.uci, m.san])).toEqual([['e2e4', 'e4']]);
    expect((await get('player=chesscom:alicecc&color=white', admin)).statusCode).toBe(200);
    expect((await get('player=lichess:carol&color=white')).statusCode).toBe(404);
    expect((await get('player=lichess:carol&color=white', owner)).statusCode).toBe(200);
    expect((await get('player=lichess:nobody&color=white', admin)).statusCode).toBe(404);
  });

  it('reads db:<id> (database access rules) from the explorer colour', async () => {
    expect((await get(`player=db:${gamesDb}&color=white`)).statusCode).toBe(200);
    const r = await explore(`player=db:${gamesDb}&color=white`, owner);
    expect(r.moves.map(m => [m.uci, m.white])).toEqual([['c2c4', 1]]);
    // Opponent ratings are the other side's.
    expect(move(r, 'c2c4')!.game!.id).toBe(`op${ids.g11}`);
    const asAdmin = await explore(`player=db:${gamesDb}&color=black`, admin);
    expect(asAdmin.white).toBe(1);
    expect((await get('player=db:999999&color=white', admin)).statusCode).toBe(404);
    // A private database: hidden from others, both as db:<id> and through the public profile's
    // PGN source (a public profile never exposes someone's private PGN collection).
    t.db.run("UPDATE databases SET visibility = 'private' WHERE id = ?", [gamesDb]);
    try {
      expect((await get(`player=db:${gamesDb}&color=white`)).statusCode).toBe(404);
      expect(move(await explore('player=alice&color=white'), 'c2c4')).toBeUndefined();
      expect(move(await explore('player=alice&color=white', owner), 'c2c4')).toMatchObject({ white: 1 });
      expect(move(await explore('player=alice&color=white', admin), 'c2c4')).toMatchObject({ white: 1 });
    } finally {
      t.db.run("UPDATE databases SET visibility = 'public' WHERE id = ?", [gamesDb]);
    }
  });

  it('reads ref:<fideId> from the reference databases', async () => {
    const w = await explore('player=ref:99999901&color=white');
    expect(w.moves.map(m => [m.uci, m.white, m.draws, m.black, m.averageOpponentRating])).toEqual([
      ['d2d4', 0, 1, 0, 2650],
      ['e2e4', 1, 0, 0, 2650],
    ]);
    const b = await explore('player=ref:99999901&color=black');
    expect(b.moves.map(m => [m.uci, m.black])).toEqual([['e2e4', 1]]);
    expect((await explore('player=ref:12345&color=white')).moves).toEqual([]);
  });

  it('enforces profile visibility and the viewer rules', async () => {
    expect((await get('player=secret&color=white')).statusCode).toBe(404);
    expect((await get('player=secret&color=white', owner)).statusCode).toBe(200);
    expect((await get('player=secret&color=white', admin)).statusCode).toBe(200);
    expect((await get('player=nobody-here&color=white')).statusCode).toBe(404);
    // Slugs are lowercase: a capitalised name typed in lila's player box still finds the profile.
    expect((await get('player=Alice&color=white')).statusCode).toBe(200);
    const anon = await get('player=alice&color=white', null);
    expect(anon.statusCode).toBe(401);
    writeSettings(t.db, { anonymousBrowsing: true });
    try {
      expect((await get('player=alice&color=white', null)).statusCode).toBe(200);
      expect((await get('player=secret&color=white', null)).statusCode).toBe(404);
      expect((await get('player=chesscom:alicecc&color=white', null)).statusCode).toBe(404);
    } finally {
      writeSettings(t.db, { anonymousBrowsing: false });
    }
  });

  it('validates its input like Lichess (400 for bad specs, colours, FENs and illegal moves)', async () => {
    const bad = async (q: string) => {
      const res = await get(q);
      expect(res.statusCode, q).toBe(400);
      expect(res.json().error.code).toBe('validation');
    };
    await bad('color=white');
    await bad('player=alice');
    await bad('player=alice&color=green');
    await bad('player=Bad%20Spec!&color=white');
    await bad('player=ftp:alice&color=white');
    await bad('player=alice&color=white&play=e2e5');
    await bad('player=alice&color=white&play=e2e4,e2e4');
    await bad('player=alice&color=white&fen=not-a-fen');
    await bad('player=alice&color=white&moves=-1');
    // Castling in either notation, FEN underscores.
    const castle = await get(`player=alice&color=white&fen=${encodeURIComponent('r3k2r/8/8/8/8/8/8/R3K2R_w_KQkq_-_0_1')}&play=e1h1`);
    expect(castle.statusCode).toBe(200);
  });

  it('answers an empty explorer for other variants (Outpost stores standard chess only)', async () => {
    const r = await explore('player=alice&color=white&variant=crazyhouse');
    expect(r).toEqual({ opening: null, queuePosition: 0, white: 0, draws: 0, black: 0, moves: [], recentGames: [] });
    const fromPos = await explore('player=alice&color=white&variant=fromPosition');
    expect(fromPos.white).toBe(5);
  });

  it('limits moves with `moves`', async () => {
    const r = await explore('player=alice&color=white&moves=1');
    expect(r.moves.map(m => m.uci)).toEqual(['e2e4']);
    // Totals still count every move, like Lichess.
    expect(r.white + r.draws + r.black).toBe(8);
  });
});
