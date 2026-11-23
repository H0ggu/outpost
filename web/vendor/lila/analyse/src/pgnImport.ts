import { makeUci } from 'chessops';
import { IllegalSetup, type Position } from 'chessops/chess';
import { makeFen } from 'chessops/fen';
import {
  makeVariant,
  parseComment,
  parsePgn,
  startingPosition,
  type ChildNode,
  type PgnNodeData,
} from 'chessops/pgn';
import { makeSanAndPlay, parseSan } from 'chessops/san';
import { makeSquare } from 'chessops/util';

import type { Player, Status } from 'lib/game';
import { completeNode } from 'lib/tree/node';
import type { Glyph, ServerEval, Shape, TreeComment, TreeNode } from 'lib/tree/types';

import type { AnalyseData, Game } from './interfaces';

// outpost: lila keeps PGN annotations only when its server imports a study chapter. Outpost has no
// server import, so read comments, NAGs, [%cal]/[%csl] shapes, [%clk] clocks and [%eval] here.

// lila's glyphs (scalachess Glyph.scala): NAG id, symbol, i18n.study key
export const pgnGlyphs: ReadonlyArray<[number, string, keyof I18n['study']]> = [
  [1, '!', 'goodMove'],
  [2, '?', 'mistake'],
  [3, '!!', 'brilliantMove'],
  [4, '??', 'blunder'],
  [5, '!?', 'interestingMove'],
  [6, '?!', 'dubiousMove'],
  [7, '□', 'onlyMove'],
  [22, '⨀', 'zugzwang'],
  [10, '=', 'equalPosition'],
  [13, '∞', 'unclearPosition'],
  [14, '⩲', 'whiteIsSlightlyBetter'],
  [15, '⩱', 'blackIsSlightlyBetter'],
  [16, '±', 'whiteIsBetter'],
  [17, '∓', 'blackIsBetter'],
  [18, '+−', 'whiteIsWinning'],
  [19, '−+', 'blackIsWinning'],
  [146, 'N', 'novelty'],
  [32, '↑↑', 'development'],
  [36, '↑', 'initiative'],
  [40, '→', 'attack'],
  [132, '⇆', 'counterplay'],
  [138, '⊕', 'timeTrouble'],
  [44, '=∞', 'withCompensation'],
  [140, '∆', 'withTheIdea'],
];

export const glyphOfNag = (nag: number): Glyph | undefined => {
  const g = pgnGlyphs.find(([id]) => id === nag);
  return g && { id: g[0], symbol: g[1], name: String(i18n.study[g[2]] ?? g[2]) };
};

export const pgnCommentId = 'pgn';

type Annotations = Pick<TreeNode, 'comments' | 'glyphs' | 'shapes' | 'clock' | 'eval'>;

const readAnnotations = (rawComments: string[], nags: number[] = [], fen: FEN): Annotations => {
  const texts: string[] = [];
  const shapes: Shape[] = [];
  const out: Annotations = {};
  for (const raw of rawComments) {
    const c = parseComment(raw);
    if (c.text) texts.push(c.text);
    for (const s of c.shapes)
      shapes.push({
        orig: makeSquare(s.from),
        dest: s.to === s.from ? undefined : makeSquare(s.to),
        brush: s.color,
      } as Shape);
    if (c.clock !== undefined) out.clock = Math.round(c.clock * 100);
    if (c.evaluation)
      out.eval = {
        ...('mate' in c.evaluation ? { mate: c.evaluation.mate } : { cp: Math.round(c.evaluation.pawns * 100) }),
        fen,
        knodes: 0,
        depth: c.evaluation.depth ?? 0,
        pvs: [],
      } as ServerEval;
  }
  if (texts.length)
    out.comments = [{ id: pgnCommentId, by: '', text: texts.join(' ') } as TreeComment];
  const glyphs = [...new Set(nags)].map(glyphOfNag).filter((g): g is Glyph => !!g);
  if (glyphs.length) out.glyphs = glyphs;
  if (shapes.length) out.shapes = shapes;
  return out;
};

const readNode = (
  variant: VariantKey,
  node: ChildNode<PgnNodeData>,
  pos: Position,
  ply: Ply,
  withChildren = true,
): TreeNode => {
  const move = parseSan(pos, node.data.san);
  if (!move) throw new Error(`Can't play ${node.data.san} at move ${Math.ceil(ply / 2)}, ply ${ply}`);
  const san = makeSanAndPlay(pos, move);
  const fen = makeFen(pos.toSetup());
  return completeNode(variant)({
    ply,
    san,
    fen,
    uci: makeUci(move),
    ...readAnnotations([...(node.data.startingComments ?? []), ...(node.data.comments ?? [])], node.data.nags, fen),
    children: withChildren ? node.children.map(child => readNode(variant, child, pos.clone(), ply + 1)) : [],
  });
};

// outpost: a finished game shows its result under the moves, like lila's game analysis
const resultOf = (headers: Map<string, string>, pos: Position): { status: Status; winner?: Color } | undefined => {
  const result = headers.get('Result');
  const winner = result === '1-0' ? 'white' : result === '0-1' ? 'black' : undefined;
  if (!winner && result !== '1/2-1/2') return undefined;
  const termination = (headers.get('Termination') ?? '').toLowerCase();
  const name = pos.isCheckmate()
    ? 'mate'
    : pos.isStalemate()
      ? 'stalemate'
      : termination.includes('time')
        ? 'outoftime'
        : termination.includes('resign')
          ? 'resign'
          : !winner
            ? 'draw'
            : 'unknownFinish';
  const ids = { mate: 30, resign: 31, stalemate: 32, draw: 34, outoftime: 35, unknownFinish: 38 } as const;
  return { status: { id: ids[name], name }, winner };
};

export default function (pgn: string): Partial<AnalyseData> {
  const game = parsePgn(pgn)[0];
  const start = startingPosition(game.headers).unwrap();
  const fen = makeFen(start.toSetup());
  const variant: VariantKey = rulesToVariantKey[start.rules] || start.rules;
  const initialPly = (start.toSetup().fullmoves - 1) * 2 + (start.turn === 'white' ? 0 : 1);
  const treeParts: TreeNode[] = [
    completeNode(variant)({
      id: '',
      ply: initialPly,
      fen,
      ...readAnnotations(game.comments ?? [], [], fen),
      children: [],
    }),
  ];
  let tree = game.moves;
  const pos = start;
  const sidelines: TreeNode[][] = [[]];
  let index = 0;
  while (tree.children.length) {
    const [mainline, ...variations] = tree.children;
    const ply = initialPly + index + 1;
    sidelines.push(variations.map(variation => readNode(variant, variation, pos.clone(), ply)));
    treeParts.push(readNode(variant, mainline, pos, ply, false));
    tree = mainline;
    index += 1;
  }
  const variantName = makeVariant(start.rules) || variant;
  const finished = resultOf(game.headers, pos);
  const eco = game.headers.get('ECO'),
    openingName = game.headers.get('Opening');
  // TODO Improve types so that analysis data != game data
  return {
    game: {
      fen,
      initialFen: fen,
      id: 'synthetic',
      opening: eco && openingName ? { eco, name: openingName, ply: 0 } : undefined,
      player: start.turn,
      status: finished?.status ?? { id: 20, name: 'started' },
      winner: finished?.winner,
      turns: treeParts.length,
      variant: {
        key: variant,
        name: variantName,
        short: variantName,
      },
    } as Game,
    player: { color: 'white' } as Player,
    opponent: { color: 'black' } as Player,
    treeParts,
    sidelines,
    userAnalysis: true,
  };
}

const rulesToVariantKey: Record<string, VariantKey> = {
  chess: 'standard',
  kingofthehill: 'kingOfTheHill',
  '3check': 'threeCheck',
  racingkings: 'racingKings',
};

export const renderPgnError = (error = '') =>
  `PGN error: ${
    {
      [IllegalSetup.Empty]: 'empty board',
      [IllegalSetup.OppositeCheck]: 'king in check',
      [IllegalSetup.PawnsOnBackrank]: 'pawns on back rank',
      [IllegalSetup.Kings]: 'king(s) missing',
      [IllegalSetup.Variant]: 'invalid Variant header',
    }[error] ?? error
  }`;
