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
