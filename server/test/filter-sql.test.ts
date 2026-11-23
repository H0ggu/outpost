import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseFilters, type ProfileFilters } from '@outpost/shared/filters';
import { insertGame } from '../src/chess/store.ts';
import { HttpError } from '../src/http/errors.ts';
import { GAME_ROW_SELECT, playerGamesWhere, toGameRow, type GameRowRecord } from '../src/stats/index.ts';
import { createSource, makeTestApp, testGame, type TestApp } from './helpers.ts';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 5, 30, 12);

describe('playerGamesWhere', () => {
  let t: TestApp;
  let alice: number;
  let aliceCc: number;
  const ids: Record<string, number> = {};

  const select = (filters: ProfileFilters, sourceIds = [alice, aliceCc]): string[] => {
    const w = playerGamesWhere(filters, { sourceIds, now: NOW });
    return t.db
      .all<{ origin_id: string }>(
        `SELECT g.origin_id FROM player_games pg JOIN games g ON g.id = pg.game_id WHERE ${w.sql} ORDER BY g.origin_id`,
        w.params,
      )
      .map(r => r.origin_id);
  };

  beforeAll(async () => {
    t = await makeTestApp();
    alice = createSource(t.db, { kind: 'lichess', key: 'alice' });
    aliceCc = createSource(t.db, { kind: 'chesscom', key: 'alice' });
    const games = {
      // alice white, beats a stronger bob two days ago (blitz, rated, Ruy Lopez)
      a: testGame({ originId: 'a', endedAt: NOW - 2 * DAY, white: { rating: 1500 }, black: { rating: 1720 }, event: 'Titled Arena' }),
      // alice black, loses to a weaker carol 40 days ago (rapid, casual, Queen's Gambit)
      b: testGame({
        originId: 'b',
        endedAt: NOW - 40 * DAY,
        white: { name: 'Carol', rating: 1300 },
        black: { name: 'alice', rating: 1500 },
        result: '1-0',
        timeClass: 'rapid',
        rated: false,
        moves: ['d4', 'd5', 'c4'],
      }),
      // alice (chess.com) white, draw with an equal dave a year ago (bullet)
      c: testGame({
        origin: 'chesscom',
        originId: 'c',
        endedAt: NOW - 400 * DAY,
        black: { name: 'Dave', rating: 1550 },
        result: '1/2-1/2',
        timeClass: 'bullet',
        moves: ['d4', 'Nf6', 'c4', 'e6'],
      }),
    };
    for (const [k, g] of Object.entries(games)) ids[k] = insertGame(t.db, g).gameId;
  });
  afterAll(async () => t.close());

  it('restricts to the given sources, narrowed by src', () => {
    expect(select({})).toEqual(['a', 'b', 'c']);
    expect(select({ src: [aliceCc] })).toEqual(['c']);
    expect(select({ src: [99999] })).toEqual([]);
    expect(select({}, [])).toEqual([]);
  });

  it('filters by colour, time class, rated and outcome', () => {
    expect(select({ color: 'black' })).toEqual(['b']);
    expect(select({ tc: ['bullet', 'rapid'] })).toEqual(['b', 'c']);
    expect(select({ rated: 'unrated' })).toEqual(['b']);
    expect(select({ outcome: ['d', 'l'] })).toEqual(['b', 'c']);
  });

  it('filters by date presets and custom days', () => {
    expect(select({ period: '7d' })).toEqual(['a']);
    expect(select({ period: '3m' })).toEqual(['a', 'b']);
    expect(select({ from: '2026-05-21', to: '2026-05-21' })).toEqual(['b']);
  });

  it('filters by relative opponent strength', () => {
    expect(select({ opp: '200' })).toEqual(['a']);
    expect(select({ opp: '-100' })).toEqual(['b']);
    expect(select({ opp: 'eq' })).toEqual(['c']);
  });

  it('filters by opponent name and event (substring, case-insensitive)', () => {
    expect(select({ oppName: 'CAR' })).toEqual(['b']);
    expect(select({ event: 'arena' })).toEqual(['a']);
    expect(select({ oppName: '100%_' })).toEqual([]);
  });

  it('filters by line, merging transpositions', () => {
    expect(select({ line: ['e2e4', 'e7e5'] })).toEqual(['a']);
    expect(select({ line: ['c2c4', 'e7e6', 'd2d4', 'g8f6'] })).toEqual(['c']);
    expect(select(parseFilters({ line: 'd2d4' }))).toEqual(['b', 'c']);
    expect(() => select({ line: ['e2e5'] })).toThrow(HttpError);
  });

  it('feeds GAME_ROW_SELECT / toGameRow', () => {
    const w = playerGamesWhere({ color: 'black' }, { sourceIds: [alice], now: NOW });
    const rows = t.db.all<GameRowRecord>(`${GAME_ROW_SELECT} WHERE ${w.sql} ORDER BY pg.ended_at DESC`, w.params).map(toGameRow);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: ids.b,
      color: 'black',
      outcome: 'l',
      rated: false,
      timeClass: 'rapid',
      opponent: { name: 'Carol', key: 'carol', rating: 1300, kind: 'lichess', country: null },
      eco: expect.stringMatching(/^D/),
    });
  });
});

describe('playerGamesWhere edge cases', () => {
  let t: TestApp;
  let me: number;
  let alt: number;
  let pgnSrc: number;
  const NOW2 = Date.UTC(2026, 2, 31, 12); // 31 March: '3m' goes back to 31 December

  const select = (filters: ProfileFilters, sourceIds = [me, alt, pgnSrc], alias?: string): string[] => {
    const a = alias ?? 'pg';
    const w = playerGamesWhere(filters, { sourceIds, now: NOW2, ...(alias ? { alias } : {}) });
    return t.db
      .all<{ k: string }>(
        `SELECT g.origin_id || ':' || ${a}.color AS k FROM player_games ${a} JOIN games g ON g.id = ${a}.game_id WHERE ${w.sql} ORDER BY k`,
        w.params,
      )
      .map(r => r.k);
  };

  beforeAll(async () => {
    t = await makeTestApp();
    me = createSource(t.db, { kind: 'lichess', key: 'me' });
    alt = createSource(t.db, { kind: 'lichess', key: 'me_alt' });
    const dbId = t.db.run("INSERT INTO databases (name, kind, created_at) VALUES ('Club', 'games', 0)").lastInsertRowid;
    pgnSrc = createSource(t.db, { kind: 'pgn', key: `${dbId}:me otb`, databaseId: dbId });
    const g = (originId: string, over: NonNullable<Parameters<typeof testGame>[0]>) =>
      insertGame(t.db, testGame({ originId, ...over, white: { name: 'me', ...over.white } }));
    // Opponent names with LIKE wildcards and a non-ASCII name.
    g('under', { endedAt: NOW2 - 3 * 3_600_000, black: { name: 'a_b' } });
    g('axb', { endedAt: NOW2 - 2 * 3_600_000, black: { name: 'axb' } });
    g('pct', { endedAt: NOW2 - 5 * 86_400_000, black: { name: '100%club' } });
    g('slash', { endedAt: NOW2 - 6 * 86_400_000, black: { name: 'back\\slash' } });
    g('oeystein', { endedAt: NOW2 - 7 * 86_400_000, black: { name: 'Øystein' } });
    // Ratings missing on one side.
    g('norating', { endedAt: NOW2 - 8 * 86_400_000, black: { name: 'anon', rating: null } });
    // me against my own alt account: one row per side.
    g('self', { endedAt: Date.UTC(2025, 11, 31, 23, 59, 59, 999), white: { name: 'me' }, black: { name: 'me_alt' }, result: '0-1' });
    // Calendar-month and day boundaries.
    g('jan1', { endedAt: Date.UTC(2026, 0, 1) });
    g('dec30', { endedAt: Date.UTC(2025, 11, 30, 23, 59, 59, 999) });
    // A knight dance back to the start position, then 1. e4: reaches the start position twice.
    g('dance', { endedAt: Date.UTC(2025, 0, 1), moves: ['Nf3', 'Nf6', 'Ng1', 'Ng8', 'e4', 'e5'] });
    // 1. Nf3 Nf6 2. d4 e6 3. c4 transposes to 1. d4 Nf6 2. c4 e6 3. Nf3 at the same ply.
    g('transpo', { endedAt: Date.UTC(2025, 0, 2), moves: ['Nf3', 'Nf6', 'd4', 'e6', 'c4'] });
    // An undated PGN game of the pgn source.
    insertGame(
      t.db,
      testGame({ origin: 'pgn', originId: `${dbId}:undated`, databaseId: dbId, white: { name: 'Me OTB' }, black: { name: 'Club Mate' }, startedAt: null, endedAt: null, rated: false, timeClass: 'unknown' }),
    );
  });
  afterAll(async () => t.close());

  it('narrows to src ids inside the profile only', () => {
    expect(select({ src: [alt] })).toEqual(['self:b']);
    expect(select({ src: [alt, 424242] })).toEqual(['self:b']);
    expect(select({ src: [alt] }, [me])).toEqual([]);
    expect(select({}).filter(k => k.startsWith('self'))).toEqual(['self:b', 'self:w']);
    expect(select({ color: 'white', src: [me, alt] }).filter(k => k.startsWith('self'))).toEqual(['self:w']);
    expect(select({ outcome: ['w'] }).filter(k => k.startsWith('self'))).toEqual(['self:b']);
  });

  it('uses the caller alias and refuses unsafe ones', () => {
    expect(select({ color: 'black', src: [alt] }, undefined, 'mine')).toEqual(['self:b']);
    expect(() => playerGamesWhere({}, { sourceIds: [me], alias: 'pg; DROP TABLE games' })).toThrow(/alias/);
    expect(() => playerGamesWhere({}, { sourceIds: [me], alias: '1pg' })).toThrow(/alias/);
  });

  it('treats LIKE wildcards in names literally and folds case beyond ASCII', () => {
    expect(select({ oppName: 'a_b' })).toEqual(['under:w']);
    expect(select({ oppName: '100%' })).toEqual(['pct:w']);
    expect(select({ oppName: '%' })).toEqual(['pct:w']);
    expect(select({ oppName: 'k\\s' })).toEqual(['slash:w']);
    expect(select({ oppName: 'ØYSTEIN' })).toEqual(['oeystein:w']);
    expect(select({ oppName: 'øyst' })).toEqual(['oeystein:w']);
  });

  it('needs both ratings for the strength filter', () => {
    const all = select({ opp: 'eq' });
    expect(all).toContain('under:w');
    expect(all).not.toContain('norating:w');
  });

  it('drops undated games only when a date filter is set', () => {
    expect(select({ src: [pgnSrc] })).toEqual([expect.stringMatching(/:undated:w$/)]);
    expect(select({ src: [pgnSrc], to: '2030-01-01' })).toEqual([]);
    expect(select({ src: [pgnSrc], period: '12m' })).toEqual([]);
    expect(select({ tc: ['unknown'], rated: 'unrated' })).toEqual([expect.stringMatching(/:undated:w$/)]);
  });

  it('bounds dates by UTC days and calendar months', () => {
    // `to` includes the whole day; `from` starts at its midnight.
    expect(select({ from: '2025-12-31', to: '2025-12-31' })).toEqual(['self:b', 'self:w']);
    expect(select({ from: '2025-12-30', to: '2025-12-30' })).toEqual(['dec30:w']);
    expect(select({ from: '2026-01-01', to: '2026-01-01' })).toEqual(['jan1:w']);
    // '3m' from 31 March 12:00 reaches back to 31 December 12:00.
    const threeMonths = select({ period: '3m' });
    expect(threeMonths).toContain('jan1:w');
    expect(threeMonths).toContain('self:w');
    expect(threeMonths).not.toContain('dec30:w');
    expect(select({ period: '24h' })).toEqual(['axb:w', 'under:w']);
  });

  it('matches a line at any ply, once per game', () => {
    // The start position after a knight dance is the start position: every dated game has it.
    const back = select({ line: ['g1f3', 'g8f6', 'f3g1', 'f6g8'] });
    expect(back).toEqual(select({}));
    expect(new Set(back).size).toBe(back.length);
    // 1. e4 e5 is reached at ply 6 in the dance game.
    expect(select({ line: ['e2e4', 'e7e5'] })).toContain('dance:w');
    expect(select({ line: ['d2d4', 'g8f6', 'c2c4', 'e7e6', 'g1f3'] })).toEqual(['transpo:w']);
    expect(select({ line: ['h2h4'] })).toEqual([]);
  });

  it('combines filters with AND', () => {
    expect(select({ color: 'white', oppName: 'a', period: '24h', outcome: ['w'], tc: ['blitz'], rated: 'rated' })).toEqual(['axb:w', 'under:w']);
    expect(select({ color: 'black', oppName: 'a', period: '24h' })).toEqual([]);
  });
});
