import { createHash } from 'node:crypto';
import { Chess, type Position } from 'chessops/chess';
import { epdOf, parseStdUci } from '@outpost/shared/chess';

/**
 * `positions.pos_key` (PLAN §4): the first 53 bits, big-endian, of SHA-1 over the UTF-8 chessops
 * EPD (`board turn castling ep`, en-passant square only when a capture is legal). Always a safe
 * JS integer, stored as SQLite INTEGER. Transpositions get the same key.
 */
export const posKey = (epd: string): number => {
  const digest = createHash('sha1').update(epd, 'utf8').digest();
  return Number(digest.readBigUInt64BE(0) >> 11n);
};

/** `posKey` of a chessops position. */
export const posKeyOf = (pos: Position): number => posKey(epdOf(pos));

/**
 * The position after a UCI line from the standard start (either castling notation), or null when
 * a move is illegal. Used for the `line` filter and the explorer's `play` parameter.
 */
export const positionAfterLine = (line: readonly string[]): Chess | null => {
  const pos = Chess.default();
  for (const uci of line) {
    const move = parseStdUci(pos, uci);
    if (!move) return null;
    pos.play(move);
  }
  return pos;
};

/** `pos_key` of the position after a UCI line from the start, or null when a move is illegal. */
export const posKeyAfterLine = (line: readonly string[]): number | null => {
  const pos = positionAfterLine(line);
  return pos ? posKeyOf(pos) : null;
};
