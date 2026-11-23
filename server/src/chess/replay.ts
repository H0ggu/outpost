/**
 * Replaying SAN mainlines and telling apart how a game ended when the source doesn't say
 * precisely (Lichess `draw`, a PGN `Termination "Normal"`). Owner: jobs (chess/).
 */
import { Chess } from 'chessops/chess';
import { makeSanAndPlay, parseSan } from 'chessops/san';
import { epdOf, type Termination } from '@outpost/shared/chess';

/** A replayed mainline. */
export interface Replay {
  /** The final position. */
  pos: Chess;
  /** Normalised SAN of every move. */
  sans: string[];
  /** The final position occurred at least three times (only computed with `trackRepetition`). */
  threefold: boolean;
}

/** Why a replay failed. */
export interface ReplayError {
  illegal: string;
  /** 1-based ply of the bad move. */
  ply: number;
}

/**
 * Replays SAN moves from the standard start. With `trackRepetition`, counts positions (chessops
 * EPD: board, side to move, castling rights and a legal en-passant square) to detect a threefold
 * repetition of the final position.
 */
export function replaySan(moves: readonly string[], opts: { trackRepetition?: boolean } = {}): Replay | ReplayError {
  const pos = Chess.default();
  const sans: string[] = [];
  const counts = opts.trackRepetition ? new Map<string, number>([[epdOf(pos), 1]]) : null;
  for (const [i, san] of moves.entries()) {
    const move = parseSan(pos, san);
    if (!move) return { illegal: san, ply: i + 1 };
    sans.push(makeSanAndPlay(pos, move));
    if (counts) {
      const epd = epdOf(pos);
      counts.set(epd, (counts.get(epd) ?? 0) + 1);
    }
  }
  const threefold = counts ? (counts.get(epdOf(pos)) ?? 0) >= 3 : false;
  return { pos, sans, threefold };
}

/** True when `replaySan` failed. */
export const isReplayError = (r: Replay | ReplayError): r is ReplayError => 'illegal' in r;

/**
 * How a drawn game ended, judged from its final position: stalemate, dead position (insufficient
 * material), threefold repetition, the 50-move rule, or null (most likely agreed).
 */
export function drawKindOf(r: Pick<Replay, 'pos' | 'threefold'>): Extract<
  Termination,
  'stalemate' | 'insufficient' | 'repetition' | 'fifty'
> | null {
  if (r.pos.isStalemate()) return 'stalemate';
  if (r.pos.isInsufficientMaterial()) return 'insufficient';
  if (r.threefold) return 'repetition';
  if (r.pos.halfmoves >= 100) return 'fifty';
  return null;
}
