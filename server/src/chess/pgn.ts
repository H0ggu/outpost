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
import { drawKindOf, type Replay } from './replay.ts';
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

/**
 * Termination named by a PGN `Termination` tag, or null when the tag doesn't say (Lichess "Normal",
 * unknown wording): the caller then judges from the final position.
 * - Chess.com: "<user> won by resignation | on time | by checkmate | - game abandoned",
 *   "Game drawn by repetition | agreement | stalemate | insufficient material |
 *   timeout vs insufficient material | 50-move rule".
 * - Lichess: "Normal", "Time forfeit", "Abandoned", "Rules infraction", "Unterminated".
 * - Other PGN: "time forfeit", "adjudication", "emergency", "death", … (anything unknown → null).
 */
export function terminationFromTag(tag: string | null, draw: boolean): Termination | null {
  if (!tag) return null;
  const t = tag.trim().toLowerCase();
  // Chess.com puts the winner's username first; only look at the words after " won ".
  const won = t.lastIndexOf(' won ');
  const drawnBy = /^game drawn by (.+)$/.exec(t);
  const reason = won >= 0 ? t.slice(won + 5) : drawnBy ? drawnBy[1]! : t;
  if (/\btimeout vs\.? insufficient|\btime\b.*\binsufficient/.test(reason)) return 'timeout_vs_insufficient';
  if (/\babandon/.test(reason)) return 'abandon';
  if (/\bresign/.test(reason)) return draw ? null : 'resign';
  if (/\bcheckmate|\bmate\b/.test(reason)) return draw ? null : 'mate';
  if (/\b(on time|time forfeit|time|flag)/.test(reason)) return draw ? 'timeout_vs_insufficient' : 'timeout';
  if (/\brepetition/.test(reason)) return draw ? 'repetition' : null;
  if (/\bagree/.test(reason)) return draw ? 'agreement' : null;
  if (/\bstalemate/.test(reason)) return draw ? 'stalemate' : null;
  if (/\binsufficient/.test(reason)) return draw ? 'insufficient' : null;
  if (/\b(50|fifty)[- ]move/.test(reason)) return draw ? 'fifty' : null;
  if (/\b(rules infraction|unterminated|adjudicat|emergency|death)/.test(reason)) return 'other';
  return null;
}

function termination(game: PgnGame, result: GameResult, final: Replay): Termination {
  if (final.pos.isCheckmate()) return 'mate';
  if (final.pos.isStalemate()) return 'stalemate';
  const draw = result === '1/2-1/2';
  const fromTag = terminationFromTag(header(game, 'Termination'), draw);
  if (fromTag) return fromTag;
  if (draw) return drawKindOf(final) ?? 'agreement';
  return 'resign';
}

/** `Variant` tag values of Chess960 (lila: "Chess960", other tools: "Fischerandom", "chess 960"). */
const CHESS960_RE = /960|fischer/i;

/** A rating diff tag (`+8`, `-12`, `0`) → number, or null. */
const ratingDiff = (s: string | null): number | null => (s && /^[+-]?\d{1,4}$/.test(s) ? Number(s) : null);

/**
 * Maps a parsed PGN game to a `NormalizedGame` (origin `pgn` for user databases, `reference` for
 * reference/broadcast databases), or says why it is skipped: variants, games from a set-up
 * position, unfinished games (`*`), games without moves (forfeits) and illegal moves.
 * - `rated`: true for Lichess-style "Rated …" events, false for "Casual …"; otherwise true when the
 *   game carries a rating diff (Lichess exports) or both players have a rating.
 * - `termination`: checkmate/stalemate from the final position, then the `Termination` tag
 *   (Chess.com and Lichess wording), then the final position for draws (dead position, threefold
 *   repetition, 50-move rule, else agreement); decisive games default to resignation.
 * - ratings are as written (`WhiteElo`); `ratingAfter` = Elo + `WhiteRatingDiff` when present.
 * - `startedAt` from `UTCDate`/`UTCTime` (else `Date`), `endedAt` from Chess.com's
 *   `EndDate`/`EndTime` when present, else the start.
 */
export function pgnToNormalizedGame(
  game: PgnGame,
  ctx: { origin: 'pgn' | 'reference'; databaseId: Id },
): NormalizedGame | { skip: PgnSkipReason; detail?: string } {
  const variant = game.headers.get('Variant');
  // chessops reads Chess960 as standard chess (same rules); without its FEN tag the game would be
  // replayed from the standard start, so it is skipped as a variant like the others.
  if (parseVariant(variant) !== 'chess' || (variant && CHESS960_RE.test(variant))) return { skip: 'variant' };
  const start = startingPosition(game.headers);
  if (start.isErr || epdOf(start.value) !== epdOf(Chess.default())) return { skip: 'fromPosition' };
  const result = parseResult(game.headers.get('Result'));
  if (!result) return { skip: 'noResult' };

  const draw = result === '1/2-1/2';
  const pos = Chess.default();
  const moves: string[] = [];
  const seen = draw ? new Map<string, number>([[epdOf(pos), 1]]) : null;
  let dedupeEpd: string | null = null;
  for (const node of game.moves.mainline()) {
    const move = parseSan(pos, node.san);
    if (!move) return { skip: 'illegalMove', detail: `${node.san} at ply ${moves.length + 1}` };
    moves.push(makeSanAndPlay(pos, move));
    if (moves.length === DEDUPE_PLY || seen) {
      const epd = epdOf(pos);
      if (moves.length === DEDUPE_PLY) dedupeEpd = epd;
      seen?.set(epd, (seen.get(epd) ?? 0) + 1);
    }
  }
  if (moves.length === 0) return { skip: 'noMoves' };
  const final: Replay = { pos, sans: moves, threefold: seen !== null && (seen.get(epdOf(pos)) ?? 0) >= 3 };

  const player = (color: 'White' | 'Black'): NormalizedPlayer => {
    const title = header(game, `${color}Title`);
    const fideId = header(game, `${color}FideId`);
    const elo = rating(header(game, `${color}Elo`));
    const diff = ratingDiff(header(game, `${color}RatingDiff`));
    return {
      name: header(game, color) ?? '?',
      rating: elo,
      ratingAfter: elo !== null && diff !== null ? elo + diff : null,
      title: isTitle(title) ? title : null,
      fideId: fideId && /^[1-9]\d{0,11}$/.test(fideId) ? fideId : null,
      accuracy: null,
    };
  };
  const white = player('White');
  const black = player('Black');
  const date = header(game, 'UTCDate') ?? header(game, 'Date');
  const at = pgnDateTime(date, header(game, 'UTCTime'));
  const end = pgnDateTime(header(game, 'EndDate'), header(game, 'EndTime'));
  const event = header(game, 'Event');
  const site = header(game, 'Site');
  const timeControl = header(game, 'TimeControl');
  const hasDiff = header(game, 'WhiteRatingDiff') !== null || header(game, 'BlackRatingDiff') !== null;
  const rated =
    event && /^rated\b/i.test(event)
      ? true
      : event && /^casual\b/i.test(event)
        ? false
        : hasDiff || (white.rating !== null && black.rating !== null);

  return {
    origin: ctx.origin,
    originId: pgnOriginId(ctx.databaseId, { white: white.name, black: black.name, date, dedupeEpd: dedupeEpd ?? epdOf(pos) }),
    url: site && /^https?:\/\//.test(site) ? site : null,
    databaseId: ctx.databaseId,
    white,
    black,
    result,
    termination: termination(game, result, final),
    timeClass: pgnTimeClass(timeControl),
    timeControl,
    rated,
    event,
    round: header(game, 'Round'),
    startedAt: at,
    endedAt: end !== null && (at === null || end >= at) ? end : at,
    moves,
    headers: Object.fromEntries(game.headers),
  };
}
