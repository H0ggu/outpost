/**
 * Explorer positions: lila's `fen` (the root of the analysis) + `play` (UCI moves from it) → the
 * position whose `positions.pos_key` the explorer looks up, plus the opening name Lichess would
 * attach to it.
 *
 * Lichess semantics (lila-openingexplorer): the response's `opening` is the deepest named opening
 * met while playing `play` from `fen` (so a move that leaves the book keeps the last name), while a
 * move row's `opening` is the name of the exact position after that move, or null.
 */
import { Chess } from 'chessops/chess';
import { INITIAL_FEN, parseFen } from 'chessops/fen';
import { makeSan } from 'chessops/san';
import type { ExplorerOpening } from '@outpost/shared/api';
import { epdOf, parseStdUci, stdUci, UCI_RE } from '@outpost/shared/chess';
import { openingAt, type OpeningBook } from '../chess/openings.ts';
import { posKey } from '../chess/posKey.ts';
import { validationError } from '../http/errors.ts';

/** Longest `play` accepted (lila stops the explorer at ply 50; a set-up root can add a few). */
export const MAX_PLAY_MOVES = 200;
/** Longest FEN accepted. */
export const MAX_FEN_LENGTH = 120;

/** The position an explorer request asks about. */
export interface ExplorerPosition {
  /** Position after `fen` + `play`. */
  pos: Chess;
  /** chessops EPD of `pos` (the transposition key text). */
  epd: string;
  /** `positions.pos_key` of `pos`. */
  key: number;
  /** Deepest named opening along `fen` + `play` (Lichess's top-level `opening`). */
  opening: ExplorerOpening | null;
  /** The played moves, standard castling. */
  line: string[];
}

/** lila sends FENs with spaces; Lichess also accepts `_` for spaces in URLs. */
export const normalizeFen = (fen: string): string => fen.trim().replace(/_/g, ' ').replace(/\s+/g, ' ');

/** Splits a `play` csv into UCI moves (syntax only). Throws 400 on malformed moves. */
export function parsePlay(play: string | undefined): string[] {
  if (!play) return [];
  const moves = play
    .split(',')
    .map(s => s.trim())
    .filter(s => s !== '');
  if (moves.length > MAX_PLAY_MOVES) throw validationError(`play: at most ${MAX_PLAY_MOVES} moves`);
  for (const m of moves) if (!UCI_RE.test(m)) throw validationError(`play: not a UCI move: ${JSON.stringify(m.slice(0, 10))}`);
  return moves;
}

/** Parses a standard-chess FEN (missing → the initial position). Throws 400 when invalid or illegal. */
export function parseStandardFen(fen: string | undefined): Chess {
  const text = fen === undefined || fen.trim() === '' ? INITIAL_FEN : normalizeFen(fen);
  if (text.length > MAX_FEN_LENGTH) throw validationError('fen: too long');
  const setup = parseFen(text);
  if (setup.isErr) throw validationError(`fen: invalid FEN (${setup.error.message})`);
  const pos = Chess.fromSetup(setup.value);
  if (pos.isErr) throw validationError(`fen: illegal position (${pos.error.message})`);
  return pos.value;
}

const asOpening = (book: OpeningBook, epd: string): ExplorerOpening | null => {
  const entry = openingAt(book, epd);
  return entry ? { eco: entry.eco, name: entry.name } : null;
};

/**
 * Resolves `fen` + `play` (both as lila sends them). Throws 400 `validation` for a bad FEN or an
 * illegal move, like Lichess (`bad request: illegal move …`).
 */
export function resolvePosition(fen: string | undefined, play: string | undefined, book: OpeningBook): ExplorerPosition {
  const pos = parseStandardFen(fen);
  const moves = parsePlay(play);
  let epd = epdOf(pos);
  let opening = asOpening(book, epd);
  const line: string[] = [];
  for (const [i, uci] of moves.entries()) {
    const move = parseStdUci(pos, uci);
    if (!move) throw validationError(`play: illegal move ${uci} at index ${i}`);
    line.push(stdUci(pos, move));
    pos.play(move);
    epd = epdOf(pos);
    opening = asOpening(book, epd) ?? opening;
  }
  return { pos, epd, key: posKey(epd), opening, line };
}

/** SAN and the named opening after a stored `next_uci` from `pos`, or null if it is not legal there. */
export function describeMove(pos: Chess, uci: string, book: OpeningBook): { uci: string; san: string; opening: ExplorerOpening | null } | null {
  const move = parseStdUci(pos, uci);
  if (!move) return null;
  const san = makeSan(pos, move);
  const after = pos.clone();
  after.play(move);
  return { uci: stdUci(pos, move), san, opening: asOpening(book, epdOf(after)) };
}
