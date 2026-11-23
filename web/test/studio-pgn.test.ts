/**
 * Studio PGN (src/studio/pgn.ts): lila tree → PGN with variations, comments, NAGs, shapes, clocks and
 * evals; multi-game files; FEN set-ups. Trees are built with chessops the way lila's importer builds
 * them (ply, fen, san, children).
 */
import { makeFen } from 'chessops/fen';
import { parsePgn, startingPosition, type ChildNode, type PgnNodeData } from 'chessops/pgn';
import { makeSanAndPlay, parseSan } from 'chessops/san';
import type { Position } from 'chessops/chess';
import { describe, expect, it } from 'vitest';
import {
  ANNOTATION_NAGS,
  emptyGamePgn,
  GLYPH_GROUPS,
  fenToPgn,
  gameTitle,
  hasPgnContent,
  joinPgnGames,
  mainlinePlyOf,
  pgnHeaders,
  positionKey,
  splitPgnGames,
  treeToPgn,
  type PgnTreeNode,
} from '../src/studio/pgn.ts';

/** A lila-like tree from PGN text (comments, NAGs and shapes are added by the tests). */
function treeOf(pgn: string): PgnTreeNode {
  const game = parsePgn(pgn)[0]!;
  const pos = startingPosition(game.headers).unwrap();
  const setup = pos.toSetup();
  const rootPly = (setup.fullmoves - 1) * 2 + (pos.turn === 'white' ? 0 : 1);
  const read = (node: ChildNode<PgnNodeData>, p: Position, ply: number): PgnTreeNode => {
    const mv = parseSan(p, node.data.san)!;
    const san = makeSanAndPlay(p, mv);
    return { ply, san, fen: makeFen(p.toSetup()), children: node.children.map(c => read(c, p.clone(), ply + 1)) };
  };
  return { ply: rootPly, fen: makeFen(setup), children: game.moves.children.map(c => read(c, pos.clone(), rootPly + 1)) };
}

const at = (root: PgnTreeNode, ...idx: number[]): PgnTreeNode => idx.reduce((n, i) => n.children[i]!, root);

describe('treeToPgn', () => {
  it('writes variations, comments, NAGs, shapes, clocks and evals', () => {
    const root = treeOf('1. e4 e5 (1... c5 2. Nf3) 2. Nf3 *');
    root.comments = [{ text: 'Start {here}' }];
    const e4 = at(root, 0);
    e4.glyphs = [{ id: 1 }, { id: 1 }, { id: 146 }];
    e4.comments = [{ text: 'Best by test' }, { text: 'engine says', comp: true }];
    e4.shapes = [
      { orig: 'e2', dest: 'e4', brush: 'green' },
      { orig: 'd5', brush: 'paleRed' },
      { orig: 'a1', dest: 'a2', brush: 'purple' },
    ];
    e4.clock = 18000;
    at(root, 0, 0).eval = { cp: 25, depth: 20 };
    at(root, 0, 1).eval = { mate: -3 };
    const pgn = treeToPgn(root, [
      ['Event', 'Test'],
      ['White', 'A'],
    ]);
    expect(pgn).toContain('[Event "Test"]');
    expect(pgn).toContain('[Result "*"]');
    expect(pgn).not.toContain('[FEN');
    expect(pgn).toContain('{ Start here }');
    expect(pgn).toContain('1. e4 $1 $146 { Best by test [%csl Rd5] [%cal Ge2e4] [%clk 0:03:00] }');
    expect(pgn).not.toContain('engine says');
    expect(pgn).not.toContain('a1a2');
    expect(pgn).toContain('e5 { [%eval 0.25,20] }');
    expect(pgn).toContain('( 1... c5 { [%eval #-3] } 2. Nf3 )');
    // what Studio writes, chessops reads back
    const back = parsePgn(pgn)[0]!;
    expect([...back.moves.mainline()].map(d => d.san)).toEqual(['e4', 'e5', 'Nf3']);
    expect(back.moves.children[0]!.data.nags).toEqual([1, 146]);
  });

  it('writes only annotation NAGs, never lila’s display glyphs (threefold ①②③ use id 9)', () => {
    const root = treeOf('1. Nf3 Nf6 2. Ng1 Ng8 *');
    at(root, 0).glyphs = [{ id: 9 }, { id: 5 }];
    at(root, 0, 0).glyphs = [{ id: 9 }];
    const pgn = treeToPgn(root);
    expect(pgn).not.toContain('$9');
    expect(pgn).toContain('1. Nf3 $5 1... Nf6 2. Ng1 Ng8');
    expect(ANNOTATION_NAGS.size).toBe(24);
    expect(GLYPH_GROUPS.map(g => g.name)).toEqual(['move', 'position', 'observation']);
  });

  it('drops computer-only lines but keeps annotated ones', () => {
    const root = treeOf('1. e4 e5 (1... c5) (1... e6) *');
    at(root, 0, 1).comp = true;
    at(root, 0, 2).comp = true;
    at(root, 0, 2).comments = [{ text: 'keep me' }];
    const pgn = treeToPgn(root);
    expect(pgn).not.toContain('c5');
    expect(pgn).toContain('1... e6 { keep me }');
  });

  it('writes SetUp/FEN for other start positions and keeps the given order of headers', () => {
    const fen = '8/8/8/4k3/8/8/4K3/4R3 w - - 0 1';
    const root = treeOf(fenToPgn(fen) + ' ');
    const pgn = treeToPgn(root, [
      ['White', 'W'],
      ['FEN', 'stale'],
      ['Result', '1-0'],
    ]);
    expect(pgnHeaders(pgn)).toEqual(expect.arrayContaining([['FEN', fen], ['SetUp', '1'], ['Result', '1-0'], ['White', 'W']]));
    expect(pgn.indexOf('[White')).toBeLessThan(pgn.indexOf('[Result'));
  });
});

describe('multi-game files', () => {
  const file = '[Event "One"]\n[Result "*"]\n\n1. e4 *\n\n[Event "Two"]\n[Result "1-0"]\n\n1. d4 d5 1-0\n';

  it('splits a file into games and joins it back', () => {
    const games = splitPgnGames(file);
    expect(games).toHaveLength(2);
    expect(pgnHeaders(games[1]!)).toContainEqual(['Event', 'Two']);
    const joined = joinPgnGames(games);
    expect(splitPgnGames(joined)).toEqual(games);
    expect(joined.endsWith('\n')).toBe(true);
  });

  it('tells PGN with moves or a position from other text', () => {
    expect(hasPgnContent('1. e4 *')).toBe(true);
    expect(hasPgnContent('[FEN "8/8/8/4k3/8/8/4K3/8 w - - 0 1"]\n\n*')).toBe(true);
    expect(hasPgnContent('hello there')).toBe(false);
    expect(hasPgnContent('')).toBe(false);
  });

  it('treats an empty file as one empty game', () => {
    expect(splitPgnGames('')).toEqual([emptyGamePgn()]);
    expect(parsePgn(emptyGamePgn())[0]!.moves.children).toHaveLength(0);
  });
});

describe('positions', () => {
  it('validates FEN set-ups with readable errors', () => {
    expect(fenToPgn('8/8/8/4k3/8/8/4K3/8 w - - 0 1')).toContain('[FEN "8/8/8/4k3/8/8/4K3/8 w - - 0 1"]');
    expect(() => fenToPgn('not a fen')).toThrow(/Invalid FEN/);
    expect(() => fenToPgn('8/8/8/8/8/8/8/8 w - - 0 1')).toThrow(/Illegal position/);
  });

  it('finds the first mainline ply reaching a position, ignoring move counters', () => {
    const root = treeOf('1. Nf3 Nf6 2. Ng1 Ng8 3. e4 *');
    const start = root.fen;
    expect(mainlinePlyOf(root, start)).toBe(0);
    expect(mainlinePlyOf(root, start.replace(/ 0 1$/, ' 4 3'))).toBe(0);
    expect(mainlinePlyOf(root, at(root, 0, 0, 0, 0, 0).fen)).toBe(5);
    expect(mainlinePlyOf(root, '8/8/8/4k3/8/8/4K3/8 w - - 0 1')).toBeUndefined();
    expect(positionKey(' a  b c d 1 2 ')).toBe('a b c d');
  });
});

describe('gameTitle', () => {
  it('prefers players, then the event, then the fallback', () => {
    expect(gameTitle([['White', 'Carlsen'], ['Black', 'Caruana']], 'x')).toBe('Carlsen – Caruana');
    expect(gameTitle([['White', '?'], ['Black', 'B'], ['Event', 'Open']], 'x')).toBe('Open');
    expect(gameTitle([], 'Imported PGN')).toBe('Imported PGN');
  });
});
