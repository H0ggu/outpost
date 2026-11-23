/**
 * A small view-only board at the end of an opening line, floating next to the element it
 * previews (the openings table shows it while an opening name is hovered or keyboard-focused,
 * as ChessMonitor does). Loaded lazily, with chessground, on the first preview.
 */
import type { Config } from '@lichess-org/chessground/config';
import type { Key } from '@lichess-org/chessground/types';
import { Chess } from 'chessops/chess';
import { makeFen } from 'chessops/fen';
import { useMemo } from 'react';
import { createPortal } from 'react-dom';
import { parseStdUci, type Color } from '@outpost/shared/chess';
import { Board } from '../../../components/Board.tsx';

/** Width of the preview board, px. */
export const LINE_PREVIEW_SIZE = 176;

/** Final FEN and last move of a UCI line (csv or array); null when a move is illegal. */
export function linePosition(line: string | readonly string[]): { fen: string; lastMove: [Key, Key] | undefined } | null {
  const moves = typeof line === 'string' ? line.split(',').filter(Boolean) : line;
  const pos = Chess.default();
  for (const uci of moves) {
    const move = parseStdUci(pos, uci);
    if (!move) return null;
    pos.play(move);
  }
  const last = moves[moves.length - 1];
  return { fen: makeFen(pos.toSetup()), lastMove: last ? [last.slice(0, 2) as Key, last.slice(2, 4) as Key] : undefined };
}

/** Where to put a `size` px popover for an anchor: below it, or above when there is no room. */
export function previewPlacement(
  anchor: Pick<DOMRect, 'left' | 'top' | 'bottom'>,
  viewport: { width: number; height: number },
  size = LINE_PREVIEW_SIZE,
): { left: number; top: number } {
  const gap = 6;
  const left = Math.max(8, Math.min(anchor.left, viewport.width - size - 8));
  const below = anchor.bottom + gap;
  const top = below + size <= viewport.height - 8 || anchor.top - gap - size < 8 ? below : anchor.top - gap - size;
  return { left, top };
}

/** Props of `LinePreview`. */
export interface LinePreviewProps {
  /** UCI line (csv). */
  line: string;
  /** Board orientation: the profile player's side. */
  color: Color;
  /** The previewed element's box (viewport coordinates). */
  anchor: Pick<DOMRect, 'left' | 'top' | 'bottom'>;
}

/** The floating board (decorative: the line is written out next to it). */
export default function LinePreview({ line, color, anchor }: LinePreviewProps) {
  const position = useMemo(() => linePosition(line), [line]);
  const config = useMemo<Config | null>(
    () =>
      position && {
        fen: position.fen,
        orientation: color,
        viewOnly: true,
        coordinates: false,
        lastMove: position.lastMove,
        animation: { enabled: false },
        drawable: { enabled: false, visible: false },
      },
    [position, color],
  );
  if (!config) return null;
  const { left, top } = previewPlacement(anchor, { width: window.innerWidth, height: window.innerHeight });
  return createPortal(
    <div className="line-preview" style={{ left, top, width: LINE_PREVIEW_SIZE }} aria-hidden>
      <Board config={config} className="line-preview__board" />
    </div>,
    document.body,
  );
}
