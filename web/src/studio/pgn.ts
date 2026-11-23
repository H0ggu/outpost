/**
 * PGN for the Studio: lila move tree → PGN with variations, comments, NAGs, drawn shapes, clocks
 * and imported evals (what My Files stores, PLAN §4 files), plus the multi-game file helpers.
 *
 * lila's own export (`pgnExport.renderFullTxt`) drops shapes and writes glyph symbols instead of
 * NAGs, so Studio writes PGN itself with chessops' `makePgn`. Reading goes through lila's patched
 * `pgnImport` (scripts/lila-patches/003), which understands everything written here.
 *
 * No lila imports here: the node type below is structural, so this module is unit-tested.
 */
import { makeFen, parseFen, INITIAL_FEN } from 'chessops/fen';
import { setupPosition } from 'chessops/variant';
import {
  ChildNode,
  makeComment,
  makePgn,
  Node,
  parsePgn,
  type CommentShape,
  type CommentShapeColor,
  type Evaluation,
  type Game,
  type PgnNodeData,
} from 'chessops/pgn';
import { parseSquare } from 'chessops/util';

/** The parts of a lila tree node that reach the PGN. */
export interface PgnTreeNode {
  ply: number;
  fen: string;
  san?: string;
  children: PgnTreeNode[];
  comments?: ReadonlyArray<{ text: string; comp?: boolean }>;
  glyphs?: ReadonlyArray<{ id: number; comp?: boolean }>;
  shapes?: ReadonlyArray<{ orig: string; dest?: string; brush?: string }>;
  /** Clock in centiseconds. */
  clock?: number;
  eval?: { cp?: number; mate?: number; depth?: number };
  comp?: boolean;
}

/** PGN header pairs in order. */
export type PgnHeaders = ReadonlyArray<readonly [string, string]>;

const BRUSH_COLORS: Readonly<Record<string, CommentShapeColor>> = {
  green: 'green',
  paleGreen: 'green',
  red: 'red',
  paleRed: 'red',
  blue: 'blue',
  paleBlue: 'blue',
  yellow: 'yellow',
};

/** True when a node (or its line) carries something a person added, not just computer analysis. */
const hasUserContent = (n: PgnTreeNode): boolean =>
  !n.comp || !!n.comments?.some(c => !c.comp) || !!n.glyphs?.some(g => !g.comp) || n.children.some(hasUserContent);

function commentOf(n: PgnTreeNode): string | undefined {
  const text = (n.comments ?? [])
    .filter(c => !c.comp)
    .map(c => c.text.replace(/[{}]/g, '').trim())
    .filter(Boolean)
    .join(' ');
  const shapes: CommentShape[] = [];
  for (const s of n.shapes ?? []) {
    const from = parseSquare(s.orig);
    const to = s.dest === undefined ? from : parseSquare(s.dest);
    const color = BRUSH_COLORS[s.brush ?? 'green'];
    if (from !== undefined && to !== undefined && color) shapes.push({ from, to, color });
  }
  const evaluation: Evaluation | undefined =
    n.eval?.mate !== undefined
      ? { mate: n.eval.mate, ...(n.eval.depth ? { depth: n.eval.depth } : {}) }
      : n.eval?.cp !== undefined
        ? { pawns: n.eval.cp / 100, ...(n.eval.depth ? { depth: n.eval.depth } : {}) }
        : undefined;
  const clock = n.clock === undefined ? undefined : n.clock / 100;
  if (!text && !shapes.length && !evaluation && clock === undefined) return undefined;
  return makeComment({ text, shapes, ...(clock === undefined ? {} : { clock }), ...(evaluation ? { evaluation } : {}) });
}

function addChildren(into: Node<PgnNodeData>, from: PgnTreeNode): void {
  for (const child of from.children) {
    if (!child.san || !hasUserContent(child)) continue;
    const data: PgnNodeData = { san: child.san };
    const nags = [...new Set((child.glyphs ?? []).filter(g => !g.comp).map(g => g.id))];
    if (nags.length) data.nags = nags;
    const comment = commentOf(child);
    if (comment) data.comments = [comment];
    const node = new ChildNode(data);
    into.children.push(node);
    addChildren(node, child);
  }
}

/** Standard start position without move counters, for comparisons. */
const INITIAL_EPD = INITIAL_FEN.split(' ').slice(0, 4).join(' ');

/**
 * Writes one game. `headers` are kept in order; `FEN`/`SetUp` are made to match the tree's root and
 * `Result` defaults to `*`.
 */
export function treeToPgn(root: PgnTreeNode, headers: PgnHeaders = []): string {
  const map = new Map<string, string>();
  for (const [k, v] of headers) if (k !== 'FEN' && k !== 'SetUp') map.set(k, v);
  if (root.fen.split(' ').slice(0, 4).join(' ') !== INITIAL_EPD) {
    map.set('SetUp', '1');
    map.set('FEN', root.fen);
  }
  if (!map.has('Result')) map.set('Result', '*');
  const game: Game<PgnNodeData> = { headers: map, moves: new Node() };
  const rootComment = commentOf(root);
  if (rootComment) game.comments = [rootComment];
  addChildren(game.moves, root);
  return makePgn(game);
}

/** The headers of a PGN's first game, in order (chessops fills the Seven Tag Roster). */
export function pgnHeaders(pgn: string): Array<[string, string]> {
  const game = parsePgn(pgn)[0];
  return game ? [...game.headers.entries()] : [];
}

/**
 * Splits a (possibly multi-game) PGN file into single-game PGNs that lila's importer can read.
 * Always returns at least one game (an empty file is one empty game).
 */
export function splitPgnGames(pgn: string): string[] {
  const games = parsePgn(pgn);
  if (!games.length) return [emptyGamePgn()];
  return games.map(g => makePgn(g));
}

/** Rebuilds a file from its single-game PGNs (one blank line between games). */
export function joinPgnGames(games: readonly string[]): string {
  return games.map(g => g.trim()).join('\n\n') + '\n';
}

/** A game with no moves from the standard position. */
export const emptyGamePgn = (): string => '[Result "*"]\n\n*\n';

/** PGN that sets up `fen` (validated; throws a readable error on an illegal position). */
export function fenToPgn(fen: string): string {
  const setup = parseFen(fen.trim());
  if (setup.isErr) throw new Error(`Invalid FEN: ${setup.error.message}`);
  const pos = setupPosition('chess', setup.value);
  if (pos.isErr) throw new Error(`Illegal position: ${pos.error.message}`);
  return `[SetUp "1"]\n[FEN "${makeFen(pos.value.toSetup())}"]\n[Result "*"]\n\n*\n`;
}

/** First four FEN fields (placement, turn, castling, en passant): equal for the same position. */
export const positionKey = (fen: string): string => fen.trim().split(/\s+/).slice(0, 4).join(' ');

/** Ply of the first mainline node whose position equals `fen`, or undefined. */
export function mainlinePlyOf(root: PgnTreeNode, fen: string): number | undefined {
  const key = positionKey(fen);
  for (let n: PgnTreeNode | undefined = root; n; n = n.children[0]) if (positionKey(n.fen) === key) return n.ply;
  return undefined;
}

/** A short title for a game from its headers: `White – Black`, the Event, or the fallback. */
export function gameTitle(headers: PgnHeaders, fallback: string): string {
  const get = (k: string): string | undefined => {
    const v = headers.find(([key]) => key === k)?.[1]?.trim();
    return v && v !== '?' ? v : undefined;
  };
  const white = get('White'),
    black = get('Black');
  if (white && black) return `${white} – ${black}`;
  return get('Event') ?? fallback;
}
