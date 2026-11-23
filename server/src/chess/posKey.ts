import { createHash } from 'node:crypto';
import type { Position } from 'chessops/chess';
import { epdOf } from '@outpost/shared/chess';

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
