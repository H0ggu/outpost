/**
 * Broadcast pieces: the "no Lichess token" notice, round status, tournament dates, and the live
 * mini-board (lila's `.mini-game`: players with title, rating, federation and clock around a
 * view-only chessground board).
 */
import type { Config } from '@lichess-org/chessground/config';
import type { Key } from '@lichess-org/chessground/types';
import { Chess } from 'chessops/chess';
import { parseFen } from 'chessops/fen';
import { memo, useMemo, type MouseEvent } from 'react';
import { Link } from 'react-router';
import type { BroadcastGamePreview, BroadcastPlayer, BroadcastRoundRef, EpochMs } from '@outpost/shared/api';
import { ApiError } from '../../../api/client.ts';
import { useSession } from '../../../api/hooks.ts';
import { Board } from '../../../components/Board.tsx';
import { ErrorBox, licon } from '../../../components/index.ts';
import { paths } from '../../../paths.ts';
import { isUnauthorized, SignInPrompt } from './QueryView.tsx';
import { formatClock, formatDateTime, sideScore } from './format.ts';

/** True when the server could not reach Lichess or has no token for it (503 upstream_unavailable). */
export const isUpstreamUnavailable = (e: unknown): boolean => e instanceof ApiError && e.code === 'upstream_unavailable';

/** Error panel of the broadcast pages: explains the Lichess token when that is the cause. */
export function BroadcastError({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const session = useSession();
  const isAdmin = session.data?.user?.role === 'admin';
  if (isUnauthorized(error)) return <SignInPrompt what="live broadcasts" />;
  if (!isUpstreamUnavailable(error)) return <ErrorBox error={error} onRetry={onRetry} title="Could not load the broadcast" />;
  return (
    <div className="lib-note lib-note--warn" role="alert">
      <i data-icon={licon.RadioTower} aria-hidden />
      <div>
        <strong>Live broadcasts aren't available on this server right now</strong>
        <p className="muted">{(error as ApiError).message}</p>
        <p>
          Outpost reads Lichess broadcasts with the server's own Lichess API token (Lichess asks apps to authenticate
          broadcast requests), and either none is set or Lichess can't be reached.{' '}
          {isAdmin ? (
            <>
              Add a personal token (any scope; <code>study:read</code> recommended) in{' '}
              <Link to={paths.admin.settings}>Admin → Settings</Link>.
            </>
          ) : (
            'Ask the admin of this Outpost to add one.'
          )}
        </p>
        {onRetry && (
          <button type="button" className="button button-secondary button-thin" data-icon={licon.Reload} onClick={onRetry}>
            Try again
          </button>
        )}
      </div>
    </div>
  );
}

/** "12–20 Nov 2026" from a tour's dates (start, optional end). */
export function formatTourDates(dates: readonly EpochMs[]): string | null {
  const [start, end] = dates;
  if (start === undefined) return null;
  const fmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  if (end === undefined || end === start) return fmt.format(start);
  try {
    return fmt.formatRange(start, end);
  } catch {
    return `${fmt.format(start)} – ${fmt.format(end)}`;
  }
}

/** A round's state for display. */
export function roundStatus(r: BroadcastRoundRef, now: number = Date.now()): { kind: 'live' | 'finished' | 'upcoming' | 'idle'; label: string } {
  if (r.ongoing) return { kind: 'live', label: 'Live' };
  if (r.finished) return { kind: 'finished', label: 'Finished' };
  if (r.startsAt && r.startsAt > now) return { kind: 'upcoming', label: `Starts ${formatDateTime(r.startsAt)}` };
  return { kind: 'idle', label: 'Not started' };
}

/** Status pill of a round. */
export function RoundStatusPill({ round }: { round: BroadcastRoundRef }) {
  const s = roundStatus(round);
  return (
    <span className={`lib-pill${s.kind === 'live' ? ' lib-pill--live' : s.kind === 'finished' ? '' : ' lib-pill--warn'}`}>
      {s.kind === 'live' && <span className="lib-live-dot" aria-hidden />}
      {s.label}
    </span>
  );
}

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
      <span className="mini-game__user">
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
