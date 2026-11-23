/**
 * Opening classifier over lichess-org/chess-openings (CC0; server/data/openings/{a..e}.tsv,
 * columns `eco name pgn`) — PLAN §7 "After inserting games".
 *
 * Entries are keyed by chessops EPD, so a game is classified by position, not move order:
 * `classifyOpening` returns the deepest ply among the first 40 whose position has a name.
 * The explorer uses `openingAt` for the `opening` field of its responses.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Chess } from 'chessops/chess';
import { parsePgn } from 'chessops/pgn';
import { parseSan } from 'chessops/san';
import { epdOf, stdUci } from '@outpost/shared/chess';
import { ROOT_DIR } from '../config.ts';

/** server/data/openings (same as `config.openingsDir`). */
export const DEFAULT_OPENINGS_DIR: string = join(ROOT_DIR, 'server', 'data', 'openings');
/** Classification looks at plies 1…40 (PLAN §7). */
export const OPENING_MAX_PLY = 40;

/** A named position. */
export interface OpeningEntry {
  eco: string;
  name: string;
  /** The book line from the start position, UCI with standard castling. */
  line: string[];
}

/** All named positions by EPD. */
export interface OpeningBook {
  byEpd: ReadonlyMap<string, OpeningEntry>;
}

/** Result of `classifyOpening`. */
export interface OpeningMatch {
  eco: string;
  name: string;
  /** Ply of the deepest named position (stored as `games.opening_ply`). */
  ply: number;
}

/** Parses the five TSVs. The first entry wins when two lines reach the same position. */
export function loadOpeningBook(dir: string = DEFAULT_OPENINGS_DIR): OpeningBook {
  const byEpd = new Map<string, OpeningEntry>();
  for (const letter of ['a', 'b', 'c', 'd', 'e']) {
    const text = readFileSync(join(dir, `${letter}.tsv`), 'utf8');
    for (const raw of text.split('\n').slice(1)) {
      const lineText = raw.trimEnd();
      if (!lineText) continue;
      const [eco, name, pgn] = lineText.split('\t');
      if (!eco || !name || !pgn) continue;
      const game = parsePgn(pgn)[0];
      if (!game) continue;
      const pos = Chess.default();
      const line: string[] = [];
      let ok = true;
      for (const node of game.moves.mainline()) {
        const move = parseSan(pos, node.san);
        if (!move) {
          ok = false;
          break;
        }
        line.push(stdUci(pos, move));
        pos.play(move);
      }
      if (!ok || line.length === 0) continue;
      const epd = epdOf(pos);
      if (!byEpd.has(epd)) byEpd.set(epd, { eco, name, line });
    }
  }
  return { byEpd };
}

const books = new Map<string, OpeningBook>();

/** The opening book, loaded once per directory and cached. */
export function getOpeningBook(dir: string = DEFAULT_OPENINGS_DIR): OpeningBook {
  let book = books.get(dir);
  if (!book) {
    book = loadOpeningBook(dir);
    books.set(dir, book);
  }
  return book;
}

/** The named opening at a position (EPD), or null. */
export function openingAt(book: OpeningBook, epd: string): OpeningEntry | null {
  return book.byEpd.get(epd) ?? null;
}

/**
 * Classifies a game from its position EPDs: `epdsByPly[i]` is the EPD after `i` plies
 * (index 0 = start). Returns the deepest named position among plies 1…40, or null.
 */
export function classifyOpening(book: OpeningBook, epdsByPly: readonly string[]): OpeningMatch | null {
  for (let ply = Math.min(OPENING_MAX_PLY, epdsByPly.length - 1); ply >= 1; ply--) {
    const entry = book.byEpd.get(epdsByPly[ply]!);
    if (entry) return { eco: entry.eco, name: entry.name, ply };
  }
  return null;
}
