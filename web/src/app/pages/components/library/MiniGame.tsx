/**
 * A live broadcast board: lila's `.mini-game` (players with title, rating, federation and clock
 * around a view-only chessground board), plus the FEN/clock helpers it needs.
 */
import type { Config } from '@lichess-org/chessground/config';
import type { Key } from '@lichess-org/chessground/types';
import { Chess } from 'chessops/chess';
import { parseFen } from 'chessops/fen';
import { memo, useMemo, type MouseEvent } from 'react';
import type { BroadcastGamePreview, BroadcastPlayer } from '@outpost/shared/api';
import { Board } from '../../../components/Board.tsx';
import { paths } from '../../../paths.ts';
import { formatClock, sideScore } from './format.ts';

/** Side to move from a FEN (white when the FEN has no turn field). */
export const turnOf = (fen: string): 'white' | 'black' => (fen.split(' ')[1] === 'b' ? 'black' : 'white');

/** Whether the side to move is in check (false for anything chessops can't read). */
export function inCheck(fen: string): boolean {
  try {
    const setup = parseFen(fen.includes(' ') ? fen : `${fen} w - - 0 1`);
    if (setup.isErr) return false;
    const pos = Chess.fromSetup(setup.value);
    return pos.isOk ? pos.value.isCheck() : false;
  } catch {
    return false;
  }
}

/**
 * The clock to show for one player: while it is their move in a live game, it runs down from the
 * last snapshot (`clock − thinkTime − seconds since the snapshot`).
 */
export function liveClock(player: BroadcastPlayer, running: boolean, thinkTime: number | null, elapsedSec: number): number | null {
  if (player.clock === null) return null;
  if (!running) return player.clock;
  return Math.max(0, player.clock - (thinkTime ?? 0) - Math.max(0, elapsedSec));
}

/** "GM Alpha (NOR), 2700": the whole line, for boards too narrow to show it all. */
export function playerTooltip(p: BroadcastPlayer): string {
  const name = [p.title, p.name || '?'].filter(Boolean).join(' ');
  return `${name}${p.fed ? ` (${p.fed})` : ''}${p.rating !== null ? `, ${p.rating}` : ''}`;
}

function PlayerLine({
  player,
  side,
  status,
  clock,
  running,
}: {
  player: BroadcastPlayer;
  side: 'white' | 'black';
  status: BroadcastGamePreview['status'];
  clock: number | null;
  running: boolean;
}) {
  const score = sideScore(status, side);
  return (
    <span className="mini-game__player">
      <span className="mini-game__user" title={playerTooltip(player)}>
        {player.fed && <span className="lib-fed" title={`Federation: ${player.fed}`}>{player.fed}</span>}
        {player.title && <span className="title-badge">{player.title}</span>}
        <span className="name">{player.name || '?'}</span>
        {player.rating !== null && <span className="rating">{player.rating}</span>}
      </span>
      {score ? (
        <span className="mini-game__result">{score}</span>
      ) : clock !== null ? (
        <span className={running ? 'mini-game__clock clock--run' : 'mini-game__clock'}>{formatClock(clock)}</span>
      ) : null}
    </span>
  );
}

/** Props of `MiniGame`. */
export interface MiniGameProps {
  game: BroadcastGamePreview;
  /** Seconds since the snapshot was taken (drives the running clock). */
  elapsedSec: number;
  /** The round is live (clocks run). */
  live: boolean;
  /** Being opened in the Studio. */
  opening: boolean;
  onOpen: (game: BroadcastGamePreview, e: MouseEvent<HTMLAnchorElement>) => void;
}

/** One live board: Black on top, the board, White below (lila's mini-game), opening the Studio on click. */
export const MiniGame = memo(function MiniGame({ game, elapsedSec, live, opening, onOpen }: MiniGameProps) {
  const turn = turnOf(game.fen);
  const playing = live && game.status === '*';
  const config = useMemo<Config>(
    () => ({
      fen: game.fen,
      orientation: 'white',
      turnColor: turnOf(game.fen),
      viewOnly: true,
      coordinates: false,
      lastMove: game.lastMove && game.lastMove.length >= 4 ? ([game.lastMove.slice(0, 2), game.lastMove.slice(2, 4)] as Key[]) : undefined,
      check: inCheck(game.fen),
      animation: { enabled: true, duration: 250 },
      drawable: { enabled: false, visible: false },
    }),
    [game.fen, game.lastMove],
  );
  const label = `${game.white.name} – ${game.black.name}${game.status === '*' ? '' : `, ${game.status}`}: open in the Studio`;
  return (
    <a
      className={['mini-game', 'lib-mini', playing && 'lib-mini--live', opening && 'lib-mini--opening'].filter(Boolean).join(' ')}
      href={paths.studio({ fen: game.fen })}
      aria-label={label}
      title={label}
      onClick={e => onOpen(game, e)}
    >
      <PlayerLine
        player={game.black}
        side="black"
        status={game.status}
        running={playing && turn === 'black'}
        clock={liveClock(game.black, playing && turn === 'black', game.thinkTime, elapsedSec)}
      />
      <span className="lib-mini__board">
        <Board config={config} />
        {opening && <span className="lib-mini__overlay">Opening…</span>}
      </span>
      <PlayerLine
        player={game.white}
        side="white"
        status={game.status}
        running={playing && turn === 'white'}
        clock={liveClock(game.white, playing && turn === 'white', game.thinkTime, elapsedSec)}
      />
    </a>
  );
});
