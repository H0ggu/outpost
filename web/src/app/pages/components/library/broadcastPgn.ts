/**
 * Picks one game out of a broadcast round's PGN (GET /api/broadcasts/round/:id.pgn) for the
 * Studio's `?pgn=`: matched by the chapter id in its URL tags, else by the players' names; only
 * the main line and the useful headers are kept (no clock/eval comments), so the link stays short.
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

/** The game of `all` that is `preview`, or null. */
export function findBroadcastGame(all: readonly Game<PgnNodeData>[], preview: Pick<BroadcastGamePreview, 'id' | 'white' | 'black'>): Game<PgnNodeData> | null {
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

/** The Studio PGN for `preview` out of the round's full PGN, or null when it isn't there. */
export function extractBroadcastGame(roundPgn: string, preview: Pick<BroadcastGamePreview, 'id' | 'white' | 'black'>): string | null {
  const game = findBroadcastGame(parsePgn(roundPgn), preview);
  return game ? compactGamePgn(game) : null;
}
