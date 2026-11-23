import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Chess } from 'chessops/chess';
import { parseSan } from 'chessops/san';
import {
  getOpeningBook,
  insertGame,
  InvalidGameError,
  openingAt,
  parsePgnGames,
  pgnDateTime,
  pgnSourceKey,
  pgnTimeClass,
  pgnToNormalizedGame,
  posKeyAfterLine,
  posKeyOf,
  rebuildPlayerGames,
  type PgnGame,
} from '../src/chess/index.ts';
import { epdOf } from '@outpost/shared/chess';
import { createSource, makeTestApp, testGame, type TestApp } from './helpers.ts';

const PGN = `[Event "Rated Blitz game"]
[Site "https://lichess.org/abcdefgh"]
[Date "2026.01.02"]
[White "Alice"]
[Black "Bob"]
[Result "0-1"]
[UTCDate "2026.01.02"]
[UTCTime "10:20:30"]
[WhiteElo "1500"]
[BlackElo "1600"]
[BlackTitle "FM"]
[TimeControl "180+2"]
[Termination "Normal"]

1. f3 e5 2. g4 Qh4# 0-1

[Event "Casual game"]
[White "Carol"]
[Black "Dave"]
[Result "*"]

1. e4 *

[Variant "Atomic"]
[White "E"]
[Black "F"]
[Result "1-0"]

1. e4 e5 1-0

[White "G"]
[Black "H"]
[Result "1/2-1/2"]
[FEN "8/8/8/8/8/8/8/K1k5 w - - 0 1"]
[SetUp "1"]

1/2-1/2
`;

async function collect(input: string | AsyncIterable<string | Uint8Array>): Promise<PgnGame[]> {
  const out: PgnGame[] = [];
  for await (const g of parsePgnGames(input)) out.push(g);
  return out;
}

describe('opening book', () => {
  it('names positions by EPD', () => {
    const book = getOpeningBook();
    expect(book.byEpd.size).toBeGreaterThan(3000);
    const pos = Chess.default();
    for (const san of ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6']) pos.play(parseSan(pos, san)!);
    expect(openingAt(book, epdOf(pos))).toMatchObject({ eco: 'C70', name: 'Ruy Lopez: Morphy Defense' });
    expect(openingAt(book, epdOf(pos))?.line).toEqual(['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5', 'a7a6']);
  });

  it('keys lines by position', () => {
    expect(posKeyAfterLine(['d2d4', 'g8f6', 'c2c4', 'e7e6'])).toBe(posKeyAfterLine(['c2c4', 'e7e6', 'd2d4', 'g8f6']));
    expect(posKeyAfterLine([])).toBe(posKeyOf(Chess.default()));
    expect(posKeyAfterLine(['e2e5'])).toBeNull();
  });
});

describe('PGN helpers', () => {
  it('streams games across arbitrary chunk boundaries', async () => {
    const bytes = new TextEncoder().encode(PGN);
    async function* chunks(): AsyncGenerator<Uint8Array> {
      for (let i = 0; i < bytes.length; i += 7) yield bytes.subarray(i, i + 7);
    }
    const streamed = await collect(chunks());
    const whole = await collect(PGN);
    expect(streamed).toHaveLength(4);
    expect(streamed.map(g => g.headers.get('White'))).toEqual(whole.map(g => g.headers.get('White')));
  });

  it('normalises PGN games and says why others are skipped', async () => {
    const [mate, unfinished, atomic, setUp] = await collect(PGN);
    const g = pgnToNormalizedGame(mate!, { origin: 'pgn', databaseId: 7 });
    if ('skip' in g) throw new Error(`skipped: ${g.skip}`);
    expect(g).toMatchObject({
      origin: 'pgn',
      databaseId: 7,
      white: { name: 'Alice', rating: 1500, title: null },
      black: { name: 'Bob', rating: 1600, title: 'FM' },
      result: '0-1',
      termination: 'mate',
      timeClass: 'blitz',
      rated: true,
      url: 'https://lichess.org/abcdefgh',
      moves: ['f3', 'e5', 'g4', 'Qh4#'],
      startedAt: Date.UTC(2026, 0, 2, 10, 20, 30),
    });
    expect(g.originId).toMatch(/^7:[0-9a-f]{40}$/);
    const again = pgnToNormalizedGame(mate!, { origin: 'pgn', databaseId: 7 });
    expect('skip' in again ? null : again.originId).toBe(g.originId);
    expect(pgnToNormalizedGame(unfinished!, { origin: 'pgn', databaseId: 7 })).toEqual({ skip: 'noResult' });
    expect(pgnToNormalizedGame(atomic!, { origin: 'pgn', databaseId: 7 })).toEqual({ skip: 'variant' });
    expect(pgnToNormalizedGame(setUp!, { origin: 'pgn', databaseId: 7 })).toEqual({ skip: 'fromPosition' });
  });

  it('parses dates and FIDE time controls', () => {
    expect(pgnDateTime('2024.05.??', null)).toBe(Date.UTC(2024, 4, 1));
    expect(pgnDateTime('????.??.??', null)).toBeNull();
    expect(pgnTimeClass('40/5400+30:1800+30')).toBe('classical');
    expect(pgnTimeClass('1/259200')).toBe('correspondence');
    expect(pgnTimeClass(null)).toBe('unknown');
  });
});

describe('insertGame', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await makeTestApp();
  });
  afterAll(async () => t.close());

  it('writes games, positions and player_games for known sources', () => {
    const alice = createSource(t.db, { kind: 'lichess', key: 'alice' });
    const r = insertGame(t.db, testGame({ originId: 'g1', white: { name: 'Alice', ratingAfter: 1508 } }));
    expect(r).toMatchObject({ inserted: true, sourceIds: [alice] });
    const game = t.db.get<Record<string, unknown>>('SELECT * FROM games WHERE id = ?', [r.gameId])!;
    expect(game).toMatchObject({
      white_key: 'alice',
      ply_count: 6,
      moves_san: 'e4 e5 Nf3 Nc6 Bb5 a6',
      eco: 'C70',
      opening_name: 'Ruy Lopez: Morphy Defense',
      opening_ply: 6,
    });
    const positions = t.db.all<{ ply: number; next_uci: string | null }>('SELECT ply, next_uci FROM positions WHERE game_id = ? ORDER BY ply', [r.gameId]);
    expect(positions.map(p => p.next_uci)).toEqual(['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5', 'a7a6', null]);
    const pg = t.db.get<Record<string, unknown>>('SELECT * FROM player_games WHERE game_id = ?', [r.gameId]);
    expect(pg).toMatchObject({
      source_id: alice,
      color: 'w',
      outcome: 'w',
      rating: 1500,
      rating_after: 1508,
      opp_name: 'bob',
      opp_key: 'bob',
      opp_source_kind: 'lichess',
      time_class: 'blitz',
      rated: 1,
    });
  });

  it('is idempotent and backfills sources added later', () => {
    const again = insertGame(t.db, testGame({ originId: 'g1' }));
    expect(again.inserted).toBe(false);
    const bob = createSource(t.db, { kind: 'lichess', key: 'bob' });
    expect(rebuildPlayerGames(t.db, bob)).toBe(1);
    expect(rebuildPlayerGames(t.db, bob)).toBe(0);
    expect(t.db.get('SELECT color, outcome FROM player_games WHERE source_id = ?', [bob])).toEqual({ color: 'b', outcome: 'l' });
  });

  it('stores castling in standard notation and rejects illegal moves', () => {
    const r = insertGame(t.db, testGame({ moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'O-O'] }));
    expect(t.db.value('SELECT next_uci FROM positions WHERE game_id = ? AND ply = 6', [r.gameId])).toBe('e1g1');
    expect(() => insertGame(t.db, testGame({ moves: ['e4', 'e4'] }))).toThrow(InvalidGameError);
  });

  it('matches pgn and fide sources in databases', () => {
    const dbId = t.db.run("INSERT INTO databases (name, kind, created_at) VALUES ('OTB', 'reference', 0)").lastInsertRowid;
    const fide = createSource(t.db, { kind: 'fide', key: '1503014' });
    const pgnSrc = createSource(t.db, { kind: 'pgn', key: pgnSourceKey(dbId, 'Carlsen, Magnus'), databaseId: dbId });
    const r = insertGame(
      t.db,
      testGame({
        origin: 'reference',
        databaseId: dbId,
        white: { name: 'Carlsen, Magnus', fideId: '1503014' },
        black: { name: 'Somebody' },
      }),
    );
    expect(r.sourceIds.sort()).toEqual([fide, pgnSrc].sort());
    expect(t.db.get('SELECT opp_source_kind, opp_key FROM player_games WHERE source_id = ?', [fide])).toEqual({
      opp_source_kind: 'pgn',
      opp_key: 'somebody',
    });
  });
});
