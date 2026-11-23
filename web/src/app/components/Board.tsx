/**
 * chessground in React (StrictMode-safe).
 *
 * chessground owns its DOM, so the component renders a host <div> once and mounts chessground
 * into a child element it creates itself; unmount destroys the instance and removes the child,
 * so StrictMode's mount → unmount → mount cycle leaves exactly one board. Later `config` changes
 * are applied with `api.set(config)` — pass a memoised config object. For moves, read
 * docs/research/web-libs.md §1–2 (chessops `chessgroundDests`, castling notation).
 */
import { Chessground } from '@lichess-org/chessground';
import type { Api } from '@lichess-org/chessground/api';
import type { Config } from '@lichess-org/chessground/config';
import { memo, useEffect, useRef } from 'react';

/** Props of `Board`. */
export interface BoardProps {
  /** chessground config; re-applied with `api.set()` whenever the object changes. */
  config: Config;
  /** Receives the chessground API after mount, and `undefined` on unmount. */
  onApi?: (api: Api | undefined) => void;
  /** Width of the (square) board, e.g. `'100%'`, `480`. Default: fill the container. */
  size?: number | string;
  className?: string;
}

/** A chessground board using the user's board theme and piece set (board.css). */
export const Board = memo(function Board({ config, onApi, size, className }: BoardProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<Api | undefined>(undefined);
  const configRef = useRef(config);
  const onApiRef = useRef(onApi);

  useEffect(() => {
    configRef.current = config;
    onApiRef.current = onApi;
  });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const el = document.createElement('div');
    host.append(el);
    const api = Chessground(el, configRef.current);
    apiRef.current = api;
    onApiRef.current?.(api);
    return () => {
      api.destroy();
      el.remove();
      apiRef.current = undefined;
      onApiRef.current?.(undefined);
    };
  }, []);

  useEffect(() => {
    apiRef.current?.set(config);
  }, [config]);

  return (
    <div
      ref={hostRef}
      className={['board-host', 'is2d', className].filter(Boolean).join(' ')}
      style={size !== undefined ? { width: size } : undefined}
    />
  );
});
