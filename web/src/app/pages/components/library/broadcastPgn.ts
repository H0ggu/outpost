/**
 * Picks one game out of a broadcast round's PGN (GET /api/broadcasts/round/:id.pgn) for the
 * Studio's `?pgn=`: matched by the chapter id in its URL tags, else by the players' names; only
 * the main line and the useful headers are kept (no clock/eval comments), so the link stays short.
 *
 * A big round is a few MB (every board, with clocks and comments), so the text is first cut into
 * games by a line scan that reads only the tag lines (`indexRoundPgn`); just the wanted game is
 * then parsed with chessops.
 */
import type { BroadcastGamePreview } from '@outpost/shared/api';
import { ChildNode, defaultGame, makePgn, parsePgn, type Game, type Node, type PgnNodeData } from 'chessops/pgn';

/** Headers kept in the Studio copy, in this order. */
const KEEP_HEADERS = [
  'Event',
  'Site',
  'Date',
  'Round',
  'White',
  'Black',
  'Result',
  'WhiteElo',
  'BlackElo',
  'WhiteTitle',
  'BlackTitle',
  'WhiteFideId',
  'BlackFideId',
  'TimeControl',
  'ECO',
  'Opening',
  'SetUp',
  'FEN',
  'BroadcastName',
] as const;

const norm = (s: string | undefined): string => (s ?? '').normalize('NFC').trim().toLowerCase();

/** Anything with PGN headers: a parsed game, or an entry of `indexRoundPgn`. */
interface HasHeaders {
  headers: Map<string, string>;
}

/** The game of `all` that is `preview`, or null. */
export function findBroadcastGame<G extends HasHeaders>(all: readonly G[], preview: Pick<BroadcastGamePreview, 'id' | 'white' | 'black'>): G | null {
  const byUrl = all.find(g =>
    ['GameURL', 'ChapterURL', 'Site'].some(tag => {
      const url = g.headers.get(tag);
      return !!url && (url.endsWith(`/${preview.id}`) || url.includes(`/${preview.id}/`) || url.includes(`/${preview.id}#`));
    }),
  );
  if (byUrl) return byUrl;
  const w = norm(preview.white.name);
  const b = norm(preview.black.name);
  return all.find(g => norm(g.headers.get('White')) === w && norm(g.headers.get('Black')) === b) ?? null;
}

/** One game of a round PGN, unparsed: its tags and its text. */
export interface RoundPgnEntry {
  headers: Map<string, string>;
  text: string;
}

/** A PGN tag line, `[Name "value"]` (a `[%clk …]` comment line is not one). */
const TAG_LINE = /^\[([A-Za-z0-9_]+)\s+"((?:[^"\\]|\\.)*)"\]\s*$/;

/**
 * The games of a multi-game PGN, cut at each tag section that follows movetext, with their tags
 * read; no moves are parsed. Linear in the text, so a round of a few MB indexes in milliseconds.
 */
export function indexRoundPgn(pgn: string): RoundPgnEntry[] {
  const lines = pgn.replace(/^\uFEFF/, '').split(/\r?\n/);
  const out: RoundPgnEntry[] = [];
  let start = -1;
  let headers = new Map<string, string>();
  let sawMoves = false;
  const close = (end: number) => {
    if (start >= 0) out.push({ headers, text: lines.slice(start, end).join('\n') });
  };
  lines.forEach((line, i) => {
    const tag = TAG_LINE.exec(line);
    if (tag) {
      if (start < 0 || sawMoves) {
        close(i);
        start = i;
        headers = new Map();
        sawMoves = false;
      }
      headers.set(tag[1]!, tag[2]!.replace(/\\(["\\])/g, '$1'));
    } else if (line.trim() !== '') {
      if (start < 0) start = i;
      sawMoves = true;
    }
  });
  close(lines.length);
  return out;
}

/** A compact PGN of one game: kept headers and the main line only. */
export function compactGamePgn(src: Game<PgnNodeData>): string {
  const out = defaultGame<PgnNodeData>(() => new Map());
  for (const tag of KEEP_HEADERS) {
    const v = src.headers.get(tag);
    if (v) out.headers.set(tag, v);
  }
  if (!out.headers.has('Result')) out.headers.set('Result', '*');
  let node: Node<PgnNodeData> = out.moves;
  for (const data of src.moves.mainline()) {
    const child = new ChildNode<PgnNodeData>({ san: data.san });
    node.children.push(child);
    node = child;
  }
  return makePgn(out);
}

/**
 * The Studio PGN for `preview` out of the round's PGN (the text, or its `indexRoundPgn` entries),
 * or null when it isn't there. Only the matching game is parsed.
 */
export function extractBroadcastGame(
  round: string | readonly RoundPgnEntry[],
  preview: Pick<BroadcastGamePreview, 'id' | 'white' | 'black'>,
): string | null {
  const entry = findBroadcastGame(typeof round === 'string' ? indexRoundPgn(round) : round, preview);
  const game = entry ? parsePgn(entry.text)[0] : undefined;
  return game ? compactGamePgn(game) : null;
}
