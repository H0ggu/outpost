/**
 * Read-only game replay with @lichess-org/pgn-viewer (PLAN §9 "Game previews").
 *
 * pgn-viewer patches (replaces) the element it is given, so it is mounted into a child <div>
 * created imperatively (docs/research/lichess-packages-assets.md §1); unmount clears it.
 * Options are read on mount: change `pgn` or the React `key` to remount with new options.
 * Lichess links and the lichess.org analysis/practice menu entries are off by default —
 * "Analyse" should open Outpost's Studio instead (paths.studio).
 */
import 'lpv-css';
import LichessPgnViewer from '@lichess-org/pgn-viewer';
import type { Opts } from '@lichess-org/pgn-viewer/interfaces';
import type PgnViewerApi from '@lichess-org/pgn-viewer/pgnViewer';
import { memo, useEffect, useRef } from 'react';

export type { PgnViewerApi };

/** Outpost defaults (no lichess.org links). */
export const PGN_VIEWER_DEFAULTS: Partial<Opts> = {
  lichess: false,
  showClocks: true,
  showMoves: 'auto',
  scrollToMove: false,
  menu: {
    getPgn: { enabled: true },
    practiceWithComputer: { enabled: false },
    analysisBoard: { enabled: false },
  },
};

/** Props of `PgnViewer`. */
export interface PgnViewerProps {
  pgn: string;
  /** Extra pgn-viewer options (merged over PGN_VIEWER_DEFAULTS); read on mount. */
  options?: Partial<Opts>;
  /** Receives the viewer controller after mount (goTo, flip, curData, …). */
  onReady?: (viewer: PgnViewerApi) => void;
  className?: string;
}

/** A pgn-viewer instance using the user's board theme and piece set. */
export const PgnViewer = memo(function PgnViewer({ pgn, options, onReady, className }: PgnViewerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const optionsRef = useRef(options);
  const onReadyRef = useRef(onReady);

  useEffect(() => {
    optionsRef.current = options;
    onReadyRef.current = onReady;
  });

  useEffect(() => {
    const container = ref.current;
    if (!container) return;
    const host = document.createElement('div');
    container.append(host);
    const viewer = LichessPgnViewer(host, { ...PGN_VIEWER_DEFAULTS, ...optionsRef.current, pgn });
    onReadyRef.current?.(viewer);
    return () => container.replaceChildren();
  }, [pgn]);

  return <div ref={ref} className={['pgn-viewer-host', 'is2d', className].filter(Boolean).join(' ')} />;
});
