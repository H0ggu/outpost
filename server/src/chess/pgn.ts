/**
 * PGN helpers shared by every PGN importer: user databases (profiles, `pgnImport`), reference and
 * broadcast imports (reference) — PLAN §5, §7. Owner: jobs (chess/); the signatures are the
 * cross-module contract.
 *
 *   for await (const game of parsePgnGames(fileStream)) {
 *     const g = pgnToNormalizedGame(game, { origin: 'pgn', databaseId });
 *     if ('skip' in g) { counts[g.skip]++; continue; }
 *     const { inserted } = insertGame(db, g);   // duplicate when !inserted
 *   }
 */
import { createHash } from 'node:crypto';
import { Chess } from 'chessops/chess';
import { PgnParser, parseVariant, startingPosition, type Game, type PgnNodeData } from 'chessops/pgn';
import { makeSanAndPlay, parseSan } from 'chessops/san';
import type { Id } from '@outpost/shared/api';
import {
  epdOf,
  isTitle,
  parseResult,
  playerKey,
  timeClassFromClock,
  timeClassFromTimeControl,
  type GameResult,
  type Termination,
  type TimeClass,
} from '@outpost/shared/chess';
import type { NormalizedGame, NormalizedPlayer } from './store.ts';

/** A parsed PGN game (chessops). */
export type PgnGame = Game<PgnNodeData>;

/**
 * Streams games out of PGN text: a string, or chunks (strings or UTF-8 bytes, e.g. a file read
 * stream or a zstd-decompressed download). Constant memory; throws when one game exceeds
 * chessops' complexity budget (a hostile or corrupt file).
 */
export async function* parsePgnGames(input: string | AsyncIterable<string | Uint8Array>): AsyncGenerator<PgnGame> {
  const ready: PgnGame[] = [];
  let failure: Error | null = null;
  const parser = new PgnParser((game, err) => {
    if (err) failure = err;
    else ready.push(game);
  });
  const drain = function* (): Generator<PgnGame> {
    if (failure) throw failure;
    while (ready.length) yield ready.shift()!;
  };
  if (typeof input === 'string') {
    parser.parse(input);
    yield* drain();
    return;
  }
  const decoder = new TextDecoder('utf-8');
  for await (const chunk of input) {
    parser.parse(typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }), { stream: true });
    yield* drain();
  }
  parser.parse(decoder.decode());
  yield* drain();
}

/** Why a PGN game was not imported (importers count these in `JobProgress.counts`). */
export type PgnSkipReason = 'variant' | 'fromPosition' | 'noResult' | 'noMoves' | 'illegalMove';

/** Ply whose position goes into the duplicate key (PLAN §5). */
export const DEDUPE_PLY = 80;

/**
 * `games.origin_id` of a PGN/reference game: `<databaseId>:<sha1>` over the players (colours
 * matter), the date as written and the position after ply 80 (or the final position) — PLAN §5.
 */
export function pgnOriginId(
  databaseId: Id,
  parts: { white: string; black: string; date: string | null; dedupeEpd: string },
): string {
  const h = createHash('sha1')
    .update([playerKey(parts.white), playerKey(parts.black), parts.date ?? '', parts.dedupeEpd].join('\n'), 'utf8')
    .digest('hex');
  return `${databaseId}:${h}`;
}

const header = (game: PgnGame, name: string): string | null => {
  const v = game.headers.get(name)?.trim();
  return v && v !== '?' && v !== '-' ? v : null;
};

const rating = (s: string | null): number | null => {
  const n = s && /^\d{1,4}$/.test(s) ? Number(s) : 0;
  return n > 0 ? n : null;
};

/** `YYYY.MM.DD` (unknown parts as `??`) + optional `HH:MM:SS` → epoch ms (UTC), or null without a year. */
export function pgnDateTime(date: string | null, time: string | null): number | null {
  const m = date ? /^(\d{4})[.\-/](\d{2}|\?\?)[.\-/](\d{2}|\?\?)$/.exec(date) : null;
  if (!m) return null;
  const y = Number(m[1]);
  const mo = m[2] === '??' ? 1 : Number(m[2]);
  const d = m[3] === '??' ? 1 : Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const t = time ? /^(\d{2}):(\d{2}):(\d{2})$/.exec(time) : null;
  const ms = Date.UTC(y, mo - 1, d, t ? Number(t[1]) : 0, t ? Number(t[2]) : 0, t ? Number(t[3]) : 0);
  return Number.isNaN(ms) ? null : ms;
}

/** Time class of a PGN TimeControl, including FIDE multi-period forms like `40/5400+30:1800+30`. */
export function pgnTimeClass(tc: string | null): TimeClass {
  const simple = timeClassFromTimeControl(tc);
  if (simple !== 'unknown' || !tc) return simple;
  const m = /^\d+\/(\d+)(?:\+(\d+))?(?::|$)/.exec(tc);
  if (m && (tc.includes(':') || m[2] !== undefined)) return timeClassFromClock({ initial: Number(m[1]), increment: Number(m[2] ?? 0) });
  return 'unknown';
}

function termination(game: PgnGame, result: GameResult, finalPos: Chess): Termination {
  if (finalPos.isCheckmate()) return 'mate';
  if (finalPos.isStalemate()) return 'stalemate';
  const draw = result === '1/2-1/2';
  if (draw && finalPos.isInsufficientMaterial()) return 'insufficient';
  const t = (header(game, 'Termination') ?? '').toLowerCase();
  if (t.includes('time')) return draw ? 'timeout_vs_insufficient' : 'timeout';
  if (t.includes('abandon')) return 'abandon';
  if (t.includes('rules') || t.includes('unterminated')) return 'other';
  return draw ? 'agreement' : 'resign';
}

/**
 * Maps a parsed PGN game to a `NormalizedGame` (origin `pgn` for user databases, `reference` for
 * reference/broadcast databases), or says why it is skipped: variants, games from a set-up
 * position, unfinished games (`*`), games without moves (forfeits) and illegal moves.
 * `rated` is true for Lichess-style "Rated …" events, false for "Casual …", otherwise true when
 * both players have a rating.
 */
export function pgnToNormalizedGame(
  game: PgnGame,
  ctx: { origin: 'pgn' | 'reference'; databaseId: Id },
): NormalizedGame | { skip: PgnSkipReason; detail?: string } {
  if (parseVariant(game.headers.get('Variant')) !== 'chess') return { skip: 'variant' };
  const start = startingPosition(game.headers);
  if (start.isErr || epdOf(start.value) !== epdOf(Chess.default())) return { skip: 'fromPosition' };
  const result = parseResult(game.headers.get('Result'));
  if (!result) return { skip: 'noResult' };

  const pos = Chess.default();
  const moves: string[] = [];
  let dedupeEpd: string | null = null;
  for (const node of game.moves.mainline()) {
    const move = parseSan(pos, node.san);
    if (!move) return { skip: 'illegalMove', detail: `${node.san} at ply ${moves.length + 1}` };
    moves.push(makeSanAndPlay(pos, move));
    if (moves.length === DEDUPE_PLY) dedupeEpd = epdOf(pos);
  }
  if (moves.length === 0) return { skip: 'noMoves' };

  const player = (color: 'White' | 'Black'): NormalizedPlayer => {
    const title = header(game, `${color}Title`);
    const fideId = header(game, `${color}FideId`);
    return {
      name: header(game, color) ?? '?',
      rating: rating(header(game, `${color}Elo`)),
      ratingAfter: null,
      title: isTitle(title) ? title : null,
      fideId: fideId && /^[1-9]\d{0,11}$/.test(fideId) ? fideId : null,
      accuracy: null,
    };
  };
  const white = player('White');
  const black = player('Black');
  const date = header(game, 'UTCDate') ?? header(game, 'Date');
  const at = pgnDateTime(date, header(game, 'UTCTime'));
  const event = header(game, 'Event');
  const site = header(game, 'Site');
  const timeControl = header(game, 'TimeControl');
  const rated = event && /^rated\b/i.test(event) ? true : event && /^casual\b/i.test(event) ? false : white.rating !== null && black.rating !== null;

  return {
    origin: ctx.origin,
    originId: pgnOriginId(ctx.databaseId, { white: white.name, black: black.name, date, dedupeEpd: dedupeEpd ?? epdOf(pos) }),
    url: site && /^https?:\/\//.test(site) ? site : null,
    databaseId: ctx.databaseId,
    white,
    black,
    result,
    termination: termination(game, result, pos),
    timeClass: pgnTimeClass(timeControl),
    timeControl,
    rated,
    event,
    round: header(game, 'Round'),
    startedAt: at,
    endedAt: at,
    moves,
    headers: Object.fromEntries(game.headers),
  };
}
