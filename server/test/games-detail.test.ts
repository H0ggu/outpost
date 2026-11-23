import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiErrorBody, GameResponse } from '@outpost/shared/api';
import { API_ROUTES } from '@outpost/shared/api';
import { insertGame, parsePgnGames, pgnSourceKey, pgnToNormalizedGame, type NormalizedGame } from '../src/chess/index.ts';
import { writeSettings } from '../src/settings.ts';
import { createSource, makeTestApp, testGame, type TestApp } from './helpers.ts';
import { createProfile, get, RUY, seedAliceWorld, type AliceWorld } from './stats-fixtures.ts';

const OTB_PGN = `[Event "Club \\"Open\\" 2024"]
[Site "Oslo NOR"]
[Date "2024.03.??"]
[Round "3.1"]
[White "Smith, Alice"]
[Black "Jones, Bob"]
[Result "0-1"]
[WhiteElo "1810"]
[BlackElo "1905"]
[WhiteFideId "1503014"]
[Annotator "Coach"]
[PlyCount "4"]

1. f3 e5 2. g4 Qh4# 0-1
`;

async function firstPgnGame(pgn: string, databaseId: number, origin: 'pgn' | 'reference' = 'pgn'): Promise<NormalizedGame> {
  for await (const g of parsePgnGames(pgn)) {
    const n = pgnToNormalizedGame(g, { origin, databaseId });
    if ('skip' in n) throw new Error(n.skip);
    return n;
  }
  throw new Error('no game');
}

describe('GET /api/games/:id', () => {
  let t: TestApp;
  let w: AliceWorld;
  let privateDb: number;
  let refDb: number;
  const ids: Record<string, number> = {};
  const status = async (id: number, cookie?: string) => (await get(t, API_ROUTES.game(id), cookie)).status;

  beforeAll(async () => {
    t = await makeTestApp();
    w = seedAliceWorld(t);
    // A private PGN database of the owner, whose "Smith, Alice" is a source of the public profile alice-otb.
    privateDb = t.db.run(
      "INSERT INTO databases (owner_user_id, name, kind, visibility, created_at) VALUES (?, 'Club games', 'games', 'private', 0)",
      [w.users.owner.id],
    ).lastInsertRowid;
    const otb = createSource(t.db, { kind: 'pgn', key: pgnSourceKey(privateDb, 'Smith, Alice'), displayName: 'Smith, Alice', databaseId: privateDb });
    createProfile(t.db, { slug: 'alice-otb', ownerUserId: w.users.owner.id, sources: [{ id: otb }] });
    ids.otb = insertGame(t.db, await firstPgnGame(OTB_PGN, privateDb)).gameId;
    ids.dbOnly = insertGame(t.db, testGame({ origin: 'pgn', originId: `${privateDb}:x`, databaseId: privateDb, white: { name: 'Nobody' }, black: { name: 'Else' } })).gameId;
    refDb = t.db.run("INSERT INTO databases (name, kind, visibility, created_at) VALUES ('Broadcasts', 'reference', 'public', 0)").lastInsertRowid;
    ids.ref = insertGame(t.db, testGame({ origin: 'reference', originId: `${refDb}:y`, databaseId: refDb, white: { name: 'Carlsen, Magnus' }, black: { name: 'Nepo' } })).gameId;
    ids.orphan = insertGame(t.db, testGame({ white: { name: 'xavier' }, black: { name: 'yolanda' } })).gameId;
  });
  afterAll(async () => t.close());

  it('returns the game and its PGN', async () => {
    const res = await get<GameResponse>(t, API_ROUTES.game(w.g.g1), w.users.other.cookie);
    expect(res.status).toBe(200);
    const { game, pgn } = res.body;
    expect(game).toMatchObject({
      id: w.g.g1,
      origin: 'lichess',
      url: 'https://lichess.org/g1aaaaaa',
      databaseId: null,
      white: { name: 'alice', key: 'alice', rating: 1500, title: null, fideId: null, accuracy: 91.5 },
      black: { name: 'bob', key: 'bob', rating: 1600, title: null, accuracy: null },
      result: '1-0',
      termination: 'resign',
      timeClass: 'blitz',
      timeControl: '180+2',
      rated: true,
      plies: 6,
      eco: 'C70',
      openingName: 'Ruy Lopez: Morphy Defense',
      openingPly: 6,
      endedAt: w.now - 86_400_000,
    });
    expect(game.originId).toMatch(/^test\d+$/);
    expect(game.headers).toMatchObject({ Event: 'Rated Blitz game', White: 'alice', Black: 'bob', Result: '1-0', Termination: 'Normal' });
    expect(pgn).toContain('[Site "https://lichess.org/g1aaaaaa"]');
    expect(pgn).toContain('[WhiteElo "1500"]');
    expect(pgn).toContain('[ECO "C70"]');
    expect(pgn.trimEnd().endsWith('1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 1-0')).toBe(true);
    const back = await firstPgnGame(pgn, 1);
    expect(back.moves).toEqual(RUY);
    expect(back.white.name).toBe('alice');
  });

  it('keeps imported headers and escapes tag values', async () => {
    const { game, pgn } = (await get<GameResponse>(t, API_ROUTES.game(ids.otb!), w.users.owner.cookie)).body;
    expect(game).toMatchObject({
      origin: 'pgn',
      databaseId: privateDb,
      event: 'Club "Open" 2024',
      round: '3.1',
      white: { name: 'Smith, Alice', rating: 1810, fideId: '1503014' },
      termination: 'mate',
      timeClass: 'unknown',
    });
    expect(game.headers).toMatchObject({ Annotator: 'Coach', Date: '2024.03.??', PlyCount: '4' });
    expect(pgn).toContain('[Event "Club \\"Open\\" 2024"]');
    expect(pgn).toContain('[Date "2024.03.??"]');
    expect(pgn).toContain('[Annotator "Coach"]');
    expect(pgn).not.toContain('UTCDate');
    const back = await firstPgnGame(pgn, privateDb);
    expect(back.originId).toBe((await firstPgnGame(OTB_PGN, privateDb)).originId); // re-imports as a duplicate
    expect(back.event).toBe('Club "Open" 2024');
  });

  it('follows profile visibility and hidden sources', async () => {
    const { owner, other, admin } = w.users;
    expect(await status(w.g.g1, other.cookie)).toBe(200);
    expect(await status(w.g.g7, owner.cookie)).toBe(200); // carol-gm is public
    expect(await status(w.g.g6, other.cookie)).toBe(404); // hidden source
    expect(await status(w.g.g6, owner.cookie)).toBe(200);
    expect(await status(w.g.g8, other.cookie)).toBe(404); // private profile
    expect(await status(w.g.g8, owner.cookie)).toBe(200);
    expect(await status(w.g.g8, admin.cookie)).toBe(200);
    expect(await status(ids.orphan!, owner.cookie)).toBe(404); // no profile, no database
    expect(await status(ids.orphan!, admin.cookie)).toBe(200);
  });

  it('follows database visibility only for database games', async () => {
    const { owner, other, admin } = w.users;
    expect(await status(ids.dbOnly!, owner.cookie)).toBe(200);
    expect(await status(ids.dbOnly!, other.cookie)).toBe(404);
    // The public alice-otb profile has a pgn source in the private database: it never opens the
    // database's games (decision 6), whether the owner or someone else made the profile.
    expect(await status(ids.otb!, other.cookie)).toBe(404);
    expect(await status(ids.otb!, owner.cookie)).toBe(200);
    expect(await status(ids.ref!, other.cookie)).toBe(200); // reference DBs are instance-wide
    t.db.run("UPDATE databases SET visibility = 'public' WHERE id = ?", [privateDb]);
    try {
      expect(await status(ids.dbOnly!, other.cookie)).toBe(200);
      expect(await status(ids.otb!, other.cookie)).toBe(200);
    } finally {
      t.db.run("UPDATE databases SET visibility = 'private' WHERE id = ?", [privateDb]);
    }
    // A reference database an admin made private is admins-only.
    t.db.run("UPDATE databases SET visibility = 'private' WHERE id = ?", [refDb]);
    try {
      expect(await status(ids.ref!, other.cookie)).toBe(404);
      expect(await status(ids.ref!, admin.cookie)).toBe(200);
    } finally {
      t.db.run("UPDATE databases SET visibility = 'public' WHERE id = ?", [refDb]);
    }
  });

  it("never serves a private database's games through another user's public profile", async () => {
    const { owner, other } = w.users;
    // `other` attached a player of the owner's database while it was public, then the owner made it private again.
    const club = t.db.run(
      "INSERT INTO databases (owner_user_id, name, kind, visibility, created_at) VALUES (?, 'Club 2', 'games', 'public', 0)",
      [owner.id],
    ).lastInsertRowid;
    const src = createSource(t.db, { kind: 'pgn', key: pgnSourceKey(club, 'Doe, Jane'), displayName: 'Doe, Jane', databaseId: club });
    createProfile(t.db, { slug: 'jane-by-other', ownerUserId: other.id, sources: [{ id: src }] });
    const game = insertGame(
      t.db,
      testGame({ origin: 'pgn', originId: `${club}:jane`, databaseId: club, white: { name: 'Doe, Jane' }, black: { name: 'Roe, Rick' } }),
    ).gameId;
    expect(await status(game, other.cookie)).toBe(200);
    t.db.run("UPDATE databases SET visibility = 'private' WHERE id = ?", [club]);
    expect(await status(game, other.cookie)).toBe(404);
    writeSettings(t.db, { anonymousBrowsing: true });
    try {
      expect(await status(game)).toBe(404);
    } finally {
      writeSettings(t.db, { anonymousBrowsing: false });
    }
    expect(await status(game, owner.cookie)).toBe(200);
  });

  it('needs a session unless anonymous browsing is on', async () => {
    expect(await status(w.g.g1)).toBe(401);
    writeSettings(t.db, { anonymousBrowsing: true });
    try {
      expect(await status(w.g.g1)).toBe(200);
      expect(await status(ids.ref!)).toBe(200);
      expect(await status(w.g.g6)).toBe(404);
      expect(await status(ids.dbOnly!)).toBe(404);
      // Database reads need a session (decision 6): a public user database stays closed to anonymous visitors.
      t.db.run("UPDATE databases SET visibility = 'public' WHERE id = ?", [privateDb]);
      try {
        expect(await status(ids.dbOnly!)).toBe(404);
        expect(await status(ids.dbOnly!, w.users.other.cookie)).toBe(200);
      } finally {
        t.db.run("UPDATE databases SET visibility = 'private' WHERE id = ?", [privateDb]);
      }
    } finally {
      writeSettings(t.db, { anonymousBrowsing: false });
    }
  });

  it('validates the id', async () => {
    const bad = await get<ApiErrorBody>(t, '/api/games/abc', w.users.other.cookie);
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('validation');
    const missing = await get<ApiErrorBody>(t, API_ROUTES.game(999_999), w.users.admin.cookie);
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('not_found');
  });
});
