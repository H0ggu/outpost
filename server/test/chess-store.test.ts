import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Chess } from 'chessops/chess';
import { parseFen } from 'chessops/fen';
import { parseSan } from 'chessops/san';
import {
  backfillPlayerTitle,
  drawKindOf,
  getOpeningBook,
  insertGame,
  InvalidGameError,
  isReplayError,
  MAX_STORED_TAGS,
  MAX_TAG_VALUE_LENGTH,
  openingAt,
  parsePgnGames,
  pgnDateTime,
  pgnSourceKey,
  pgnTimeClass,
  pgnToNormalizedGame,
  posKeyAfterLine,
  posKeyOf,
  rebuildPlayerGames,
  reindexGames,
  replaySan,
  terminationFromTag,
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

  it('skips Chess960 games even without their FEN tag (chessops reads them as standard chess)', async () => {
    for (const variant of ['Chess960', 'Fischerandom', 'chess 960']) {
      const [g] = await collect(`[Variant "${variant}"]\n[White "A"]\n[Black "B"]\n[Result "1-0"]\n\n1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0\n`);
      expect(pgnToNormalizedGame(g!, { origin: 'pgn', databaseId: 7 })).toEqual({ skip: 'variant' });
    }
    const [standard] = await collect('[Variant "Standard"]\n[Result "1-0"]\n\n1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0\n');
    expect('skip' in pgnToNormalizedGame(standard!, { origin: 'pgn', databaseId: 7 })).toBe(false);
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
    const dbId = t.db.run("INSERT INTO databases (name, kind, visibility, created_at) VALUES ('OTB', 'reference', 'public', 0)").lastInsertRowid;
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

describe('PGN refinements', () => {
  const one = async (pgn: string): Promise<PgnGame> => (await collect(pgn))[0]!;
  const norm = async (pgn: string) => {
    const g = pgnToNormalizedGame(await one(pgn), { origin: 'pgn', databaseId: 1 });
    if ('skip' in g) throw new Error(g.skip);
    return g;
  };

  it('reads terminations from Chess.com and Lichess tags', () => {
    const cases: Array<[string, boolean, string | null]> = [
      ['Hikaru won by resignation', false, 'resign'],
      ['Hikaru won on time', false, 'timeout'],
      ['Hikaru won by checkmate', false, 'mate'],
      ['Hikaru won - game abandoned', false, 'abandon'],
      ['Timewarp won by resignation', false, 'resign'],
      ['Game drawn by repetition', true, 'repetition'],
      ['Game drawn by agreement', true, 'agreement'],
      ['Game drawn by stalemate', true, 'stalemate'],
      ['Game drawn by insufficient material', true, 'insufficient'],
      ['Game drawn by timeout vs insufficient material', true, 'timeout_vs_insufficient'],
      ['Game drawn by 50-move rule', true, 'fifty'],
      ['Normal', false, null],
      ['Normal', true, null],
      ['Time forfeit', false, 'timeout'],
      ['Time forfeit', true, 'timeout_vs_insufficient'],
      ['Abandoned', false, 'abandon'],
      ['Rules infraction', false, 'other'],
      ['Unterminated', true, 'other'],
      ['adjudication', false, 'other'],
      ['something new', false, null],
    ];
    for (const [tag, draw, want] of cases) expect([tag, draw, terminationFromTag(tag, draw)]).toEqual([tag, draw, want]);
    expect(terminationFromTag(null, false)).toBeNull();
    expect(terminationFromTag('Game drawn by time and insufficient material', true)).toBe('timeout_vs_insufficient');
  });

  it('reads a huge hostile Termination tag in linear time (no regex backtracking)', () => {
    for (const filler of ['time ', 'x won by time ', 'game drawn by time ']) {
      const tag = filler.repeat(Math.ceil(320_000 / filler.length));
      const t0 = performance.now();
      terminationFromTag(tag, true);
      terminationFromTag(tag, false);
      expect(performance.now() - t0).toBeLessThan(50);
    }
  });

  it('bounds the tags it stores and reads', async () => {
    const extra = Array.from({ length: 100 }, (_, i) => `[Extra${i} "v"]`).join('\n');
    const long = 'n'.repeat(50_000);
    const g = await norm(`[Event "${long}"]\n[White "A"]\n[Black "B"]\n[Result "1-0"]\n[Termination "${'time '.repeat(20_000)}"]\n${extra}\n\n1. e4 e5 1-0\n`);
    expect(Object.keys(g.headers!)).toHaveLength(MAX_STORED_TAGS);
    expect(g.headers!.Event).toHaveLength(MAX_TAG_VALUE_LENGTH);
    expect(g.event).toHaveLength(MAX_TAG_VALUE_LENGTH);
    expect(g.termination).toBe('timeout');
  });

  it('uses rating diffs, end tags and the final position', async () => {
    const lichess = await norm(`[Event "Hourly Blitz Arena"]
[White "A"]
[Black "B"]
[Result "1-0"]
[UTCDate "2026.01.02"]
[UTCTime "10:00:00"]
[WhiteElo "1500"]
[BlackElo "1510"]
[WhiteRatingDiff "+7"]
[BlackRatingDiff "-7"]
[Termination "Time forfeit"]

1. e4 e5 1-0`);
    expect(lichess).toMatchObject({ rated: true, termination: 'timeout', white: { rating: 1500, ratingAfter: 1507 }, black: { ratingAfter: 1503 } });

    const chesscom = await norm(`[Event "Live Chess"]
[White "Hikaru"]
[Black "Opponent01"]
[Result "1/2-1/2"]
[UTCDate "2026.10.02"]
[UTCTime "22:05:06"]
[Termination "Game drawn by repetition"]
[EndDate "2026.10.02"]
[EndTime "22:09:59"]

1. Nf3 Nf6 2. Ng1 Ng8 1/2-1/2`);
    expect(chesscom).toMatchObject({
      termination: 'repetition',
      rated: false,
      startedAt: Date.UTC(2026, 9, 2, 22, 5, 6),
      endedAt: Date.UTC(2026, 9, 2, 22, 9, 59),
    });

    const threefold = await norm(`[White "A"]
[Black "B"]
[Result "1/2-1/2"]
[Termination "Normal"]

1. Nf3 Nf6 2. Ng1 Ng8 3. Nf3 Nf6 4. Ng1 Ng8 1/2-1/2`);
    expect(threefold.termination).toBe('repetition');
    const agreed = await norm(`[White "A"]
[Black "B"]
[Result "1/2-1/2"]

1. e4 e5 1/2-1/2`);
    expect(agreed.termination).toBe('agreement');
  });

  it('replays moves and judges draws from the final position', () => {
    const r = replaySan(['Nf3', 'Nf6', 'Ng1', 'Ng8', 'Nf3', 'Nf6', 'Ng1', 'Ng8'], { trackRepetition: true });
    if (isReplayError(r)) throw new Error('illegal');
    expect(r.threefold).toBe(true);
    expect(drawKindOf(r)).toBe('repetition');
    expect(replaySan(['e4', 'e4'])).toEqual({ illegal: 'e4', ply: 2 });
    const pos = (fen: string, halfmoves = 0) => {
      const setup = parseFen(fen).unwrap();
      const p = Chess.fromSetup(setup).unwrap();
      p.halfmoves = halfmoves;
      return p;
    };
    expect(drawKindOf({ pos: pos('8/8/8/4k3/8/8/8/4K3 w - - 0 1'), threefold: false })).toBe('insufficient');
    expect(drawKindOf({ pos: pos('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1'), threefold: false })).toBe('stalemate');
    expect(drawKindOf({ pos: pos('4k3/8/8/8/8/8/4P3/4K2R w - - 0 1', 100), threefold: false })).toBe('fifty');
    expect(drawKindOf({ pos: pos('4k3/8/8/8/8/8/4P3/4K2R w - - 0 1', 10), threefold: false })).toBeNull();
  });
});

describe('store maintenance', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await makeTestApp();
  });
  afterAll(async () => t.close());

  it('lets a source’s own sync refresh the ratings written while syncing its opponent', () => {
    const carol = createSource(t.db, { kind: 'chesscom', key: 'carol' });
    const dave = createSource(t.db, { kind: 'chesscom', key: 'dave' });
    // First seen in Dave's archive: Carol's pre-game rating is unknown there (post-game value).
    const g = testGame({ origin: 'chesscom', originId: 'cc-shared', white: { name: 'Carol', rating: 1510, ratingAfter: 1510 }, black: { name: 'Dave' } });
    insertGame(t.db, g, { sourceId: dave });
    expect(t.db.get('SELECT rating, rating_after FROM player_games WHERE source_id = ?', [carol])).toEqual({ rating: 1510, rating_after: 1510 });
    // Carol's own sync knows her previous rating.
    const again = insertGame(t.db, { ...g, white: { ...g.white, rating: 1500 } }, { sourceId: carol });
    expect(again.inserted).toBe(false);
    expect(t.db.get('SELECT rating, rating_after FROM player_games WHERE source_id = ?', [carol])).toEqual({ rating: 1500, rating_after: 1510 });
    // Other sources' rows are never overwritten by someone else's import.
    insertGame(t.db, { ...g, black: { ...g.black, rating: 1 } }, { sourceId: carol });
    expect(t.db.value('SELECT rating FROM player_games WHERE source_id = ?', [dave])).toBe(1500);
  });

  it('re-indexes openings and positions from the stored moves', () => {
    const r = insertGame(t.db, testGame({ originId: 'reindex-me' }));
    t.db.run("UPDATE games SET eco = 'X00', opening_name = 'Wrong', opening_ply = 1 WHERE id = ?", [r.gameId]);
    t.db.run('DELETE FROM positions WHERE game_id = ? AND ply > 2', [r.gameId]);
    expect(reindexGames(t.db, [r.gameId, 987654])).toEqual({ updated: 1, invalid: 0 });
    expect(t.db.get('SELECT eco, opening_name, opening_ply FROM games WHERE id = ?', [r.gameId])).toEqual({
      eco: 'C70',
      opening_name: 'Ruy Lopez: Morphy Defense',
      opening_ply: 6,
    });
    expect(t.db.value('SELECT COUNT(*) FROM positions WHERE game_id = ?', [r.gameId])).toBe(7);
    t.db.run("UPDATE games SET moves_san = 'e4 e4' WHERE id = ?", [r.gameId]);
    expect(reindexGames(t.db, [r.gameId])).toEqual({ updated: 0, invalid: 1 });
  });

  it('backfills titles learnt later on games of that site only', () => {
    const me = createSource(t.db, { kind: 'chesscom', key: 'erin' });
    insertGame(t.db, testGame({ origin: 'chesscom', originId: 'cc-title', white: { name: 'Erin' }, black: { name: 'Frank' } }));
    insertGame(t.db, testGame({ origin: 'lichess', originId: 'li-title', white: { name: 'Frank' }, black: { name: 'Erin' } }));
    expect(backfillPlayerTitle(t.db, 'chesscom', 'frank', 'FM')).toBe(2);
    expect(t.db.value("SELECT black_title FROM games WHERE origin_id = 'cc-title'")).toBe('FM');
    expect(t.db.value("SELECT white_title FROM games WHERE origin_id = 'li-title'")).toBeNull();
    expect(t.db.value('SELECT opp_title FROM player_games WHERE source_id = ?', [me])).toBe('FM');
    expect(backfillPlayerTitle(t.db, 'chesscom', 'frank', 'IM')).toBe(0);
  });
});
