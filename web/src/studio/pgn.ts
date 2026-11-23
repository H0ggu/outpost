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

/**
 * lila's annotation glyphs (scalachess Glyph.scala), grouped like its study panel: one move glyph and
 * one position glyph at most, any observations. Only these NAGs are written: lila also puts display-only
 * glyphs on nodes (e.g. id 9 for the ①②③ of a threefold repetition), which must not become `$9`.
 */
export const GLYPH_GROUPS: ReadonlyArray<{ name: 'move' | 'position' | 'observation'; exclusive: boolean; ids: readonly number[] }> = [
  { name: 'move', exclusive: true, ids: [1, 2, 3, 4, 5, 6, 7, 22] },
  { name: 'position', exclusive: true, ids: [10, 13, 14, 15, 16, 17, 18, 19] },
  { name: 'observation', exclusive: false, ids: [146, 32, 36, 40, 132, 138, 44, 140] },
];

/** NAGs the Studio reads and writes. */
export const ANNOTATION_NAGS: ReadonlySet<number> = new Set(GLYPH_GROUPS.flatMap(g => g.ids));

const GLYPH_RANK: ReadonlyMap<number, number> = new Map(GLYPH_GROUPS.flatMap((g, rank) => g.ids.map(id => [id, rank] as const)));

/**
 * Glyphs in the usual order, whatever order they were added in: the move glyph, then the position
 * glyph, then observations (`e4!? ±`, `1. e4 $5 $16`). Stable within a group; unknown ids go last.
 */
export function sortGlyphs<T extends { id: number }>(glyphs: readonly T[]): T[] {
  return [...glyphs].sort((a, b) => (GLYPH_RANK.get(a.id) ?? 3) - (GLYPH_RANK.get(b.id) ?? 3));
}

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
  // chessops puts a space between text and annotations even when there is no text
  return makeComment({ text, shapes, ...(clock === undefined ? {} : { clock }), ...(evaluation ? { evaluation } : {}) }).trim();
}

function addChildren(into: Node<PgnNodeData>, from: PgnTreeNode): void {
  for (const child of from.children) {
    if (!child.san || !hasUserContent(child)) continue;
    const data: PgnNodeData = { san: child.san };
    const nags = [...new Set(sortGlyphs((child.glyphs ?? []).filter(g => !g.comp && ANNOTATION_NAGS.has(g.id))).map(g => g.id))];
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

const TAG_LINE = /^\[\s*([A-Za-z0-9_+#=:-]+)\s*"((?:[^"\\]|\\.)*)"\s*\]$/;

/**
 * The headers of a single-game PGN read from its tag section alone (no moves are parsed), for lists
 * of thousands of games. Only the tags present, in order; `pgnHeaders` also fills the Seven Tag Roster.
 */
export function quickHeaders(pgn: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let at = pgn.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (at < pgn.length) {
    const end = pgn.indexOf('\n', at);
    const line = pgn.slice(at, end === -1 ? pgn.length : end).trim();
    at = end === -1 ? pgn.length : end + 1;
    if (!line) {
      if (out.length) break;
      continue;
    }
    const m = TAG_LINE.exec(line);
    if (!m) break;
    out.push([m[1]!, m[2]!.replace(/\\(["\\])/g, '$1')]);
  }
  return out;
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

/** True when text holds at least one move or a set-up position (chessops reads any text as PGN). */
export function hasPgnContent(pgn: string): boolean {
  return parsePgn(pgn).some(g => g.moves.children.length > 0 || g.headers.has('FEN'));
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
