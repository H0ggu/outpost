/**
 * Games at a position: the Studio's query for `/api/explorer/games` (src/studio/positionGames.ts)
 * and the embed ↔ Explorer tab messages (src/app/explorerEmbed.ts).
 */
import type { ExplorerGamesPage, GameRow } from '@outpost/shared/api';
import { decodeFiltersSegment, encodeFiltersSegment, filtersToQuery } from '@outpost/shared/filters';
import { describe, expect, it } from 'vitest';
import { readEmbedMessage } from '../src/app/explorerEmbed.ts';
import {
  appendPage,
  lineFilterOf,
  POSITION_GAMES_PAGE,
  positionGamesQuery,
  sanOfLine,
  type PositionGamesRequest,
  type PositionGamesState,
} from '../src/studio/positionGames.ts';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const req = (over: Partial<PositionGamesRequest> = {}): PositionGamesRequest => ({
  player: 'hikaru',
  color: 'black',
  rootFen: START,
  play: ['e2e4', 'c7c5'],
  fen: 'rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
  speeds: ['bullet', 'blitz'],
  modes: ['rated'],
  since: '2026-01',
  until: '',
  total: 97,
  ...over,
});

describe('positionGamesQuery', () => {
  it("asks for the explorer's position, restrictions and the profile's filters, with the explorer's colour", () => {
    const segment = encodeFiltersSegment({ tc: ['blitz'], color: 'white', oppName: 'magnus' });
    const q = positionGamesQuery(req(), segment, 2);
    expect(Object.fromEntries(q)).toEqual({
      ...Object.fromEntries(filtersToQuery({ tc: ['blitz'], oppName: 'magnus', color: 'black' })),
      player: 'hikaru',
      fen: START,
      play: 'e2e4,c7c5',
      speeds: 'bullet,blitz',
      modes: 'rated',
      since: '2026-01',
      page: '2',
      pageSize: String(POSITION_GAMES_PAGE),
    });
    expect(q.has('until')).toBe(false);
    // The colour is a filter of the endpoint: the explorer's side wins over the segment's.
    expect(decodeFiltersSegment(segment).color).toBe('white');
    expect(q.get('color')).toBe('black');
  });

  it('sends no filters for other players, and survives an unreadable segment', () => {
    const q = positionGamesQuery(req({ play: [], speeds: [], modes: [] }), undefined, 1, 50);
    expect([...q.keys()].sort()).toEqual(['color', 'fen', 'page', 'pageSize', 'player', 'since']);
    expect(q.get('pageSize')).toBe('50');
    expect(positionGamesQuery(req(), '!!not-a-segment', 1).get('player')).toBe('hikaru');
  });
});

describe('lines', () => {
  it('writes the moves as numbered SAN, from the start or a set-up position', () => {
    expect(sanOfLine(START, ['e2e4', 'c7c5', 'b1c3'])).toBe('1. e4 c5 2. Nc3');
    expect(sanOfLine(START, [])).toBe('');
    const blackToMove = 'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';
    expect(sanOfLine(blackToMove, ['e1g1', 'f6e4'])).toBe('4. O-O Nxe4');
    expect(sanOfLine(blackToMove.replace(' w ', ' b '), ['f6e4'])).toBe('4... Nxe4');
    expect(sanOfLine(START, ['e2e5'])).toBeNull();
    expect(sanOfLine('not a fen', [])).toBeNull();
  });

  it('turns the moves into a line filter only from the start position, in standard castling', () => {
    const castle = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'g8f6', 'e1h1'];
    expect(lineFilterOf(START, castle)).toEqual([...castle.slice(0, -1), 'e1g1']);
    expect(lineFilterOf(START, [])).toEqual([]);
    expect(lineFilterOf('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1', ['c7c5'])).toBeNull();
    expect(lineFilterOf(START, ['e2e5'])).toBeNull();
    const long = Array.from({ length: 13 }, () => ['g1f3', 'g8f6', 'f3g1', 'f6g8']).flat();
    expect(long.length).toBeGreaterThan(50);
    expect(lineFilterOf(START, long)).toBeNull();
  });
});

describe('appendPage', () => {
  const row = (id: number) => ({ id }) as GameRow;
  const state = (games: GameRow[]): PositionGamesState => ({
    req: req(),
    label: 'Hikaru',
    san: '1. e4 c5',
    status: 'loading',
    total: null,
    pages: 0,
    rows: { perspective: 'player', games },
  });
  it('appends pages of the same perspective and replaces the other one', () => {
    const page: ExplorerGamesPage = { total: 3, page: 2, pageSize: 2, perspective: 'player', games: [row(3)] };
    expect(appendPage(state([row(1), row(2)]), page)).toEqual({ perspective: 'player', games: [row(1), row(2), row(3)] });
    const neutral: ExplorerGamesPage = { total: 1, page: 1, pageSize: 2, perspective: 'neutral', games: [] };
    expect(appendPage(state([row(1)]), neutral)).toEqual({ perspective: 'neutral', games: [] });
  });
});

describe('embed messages', () => {
  const position = { type: 'outpost:position', player: 'hikaru', color: 'white', line: ['e2e4'], fen: START, games: 12 };

  it('reads the position and show-games messages', () => {
    expect(readEmbedMessage(position)).toEqual(position);
    expect(readEmbedMessage({ ...position, line: null, games: null })).toEqual({ ...position, line: null, games: null });
    expect(readEmbedMessage({ type: 'outpost:show-games', player: 'hikaru', color: 'black', line: ['e2e4', 'c7c5'] })).toEqual({
      type: 'outpost:show-games',
      player: 'hikaru',
      color: 'black',
      line: ['e2e4', 'c7c5'],
    });
  });

  it('ignores anything else', () => {
    for (const junk of [
      null,
      'outpost:position',
      { ...position, type: 'other' },
      { ...position, color: 'red' },
      { ...position, player: 3 },
      { ...position, fen: 42 },
      { type: 'outpost:show-games', player: 'hikaru', color: 'white', line: null },
      { type: 'outpost:show-games', player: 'hikaru', color: 'white', line: ['e2e4', 'javascript:'] },
    ])
      expect(readEmbedMessage(junk)).toBeNull();
    // Bad lines and counts are dropped, not trusted.
    expect(readEmbedMessage({ ...position, line: ['zz'], games: -1 })).toEqual({ ...position, line: null, games: null });
    expect(readEmbedMessage({ ...position, games: 1.5 })).toMatchObject({ games: null });
  });
});
