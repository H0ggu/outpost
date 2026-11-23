/**
 * Reference games from PGN: `pgnToNormalizedGame` (origin `reference`) plus what Lichess broadcast
 * PGNs need on top — PLAN §5 (reference DB), research lichess-api.md §4–§5:
 * - `BroadcastName` is the event (the `Event` tag is sometimes the chapter name, "Round 6: A - B");
 * - `GameURL` is the game link and gives the study chapter id used to deduplicate across round
 *   imports and monthly dumps;
 * - TimeControl is the organiser's text (`90+30` minutes, free text…), see ./timeControl.ts;
 * - engine games (`BOT` titles, e.g. TCEC) and unplayed/forfeited boards are skipped;
 * - amateur boards sometimes carry the rating inside the name ("2162 Some Player").
 */
import type { Id } from '@outpost/shared/api';
import type { Termination } from '@outpost/shared/chess';
import { pgnToNormalizedGame, type NormalizedGame, type PgnGame, type PgnSkipReason } from '../chess/index.ts';
import { otbTimeControl } from './timeControl.ts';

/** Why a reference game was not imported. */
export type ReferenceSkipReason = PgnSkipReason | 'engine' | 'unplayed';

/** What a broadcast round import knows beyond the PGN (from the round's JSON). */
export interface RoundHints {
  tourName?: string | null;
  /** Round start (epoch ms): the date of games whose PGN has none. */
  startsAt?: number | null;
  /** `tour.info.fideTC`: `standard` | `rapid` | `blitz`. */
  fideTC?: string | null;
  /** FIDE federation by FIDE id, from the round's game previews. */
  federations?: ReadonlyMap<string, string>;
}

/** A reference game ready for `insertGame`, with what the importer needs besides. */
export interface ReferenceGame {
  game: NormalizedGame;
  /** `<roundId>/<chapterId>` of a Lichess broadcast game, else null. */
  chapterKey: string | null;
  federations: { white: string | null; black: string | null };
}

const BROADCAST_GAME_URL_RE = /^https:\/\/lichess\.org\/broadcast\/[^/\s]+\/[^/\s]+\/([A-Za-z0-9]{8})\/([A-Za-z0-9]{8})(?:[/?#]|$)/;
const UNPLAYED_NAMES = /^(?:no ?player|bye|forfeit)$/i;
const FED_RE = /^[A-Z]{3}$/;

const tag = (h: Record<string, string>, name: string): string | null => {
  const v = h[name]?.trim();
  return v && v !== '?' && v !== '-' ? v : null;
};

/** `<roundId>/<chapterId>` from a Lichess broadcast game URL, or null. */
export function broadcastChapterKey(url: string | null | undefined): string | null {
  const m = url ? BROADCAST_GAME_URL_RE.exec(url.trim()) : null;
  return m ? `${m[1]}/${m[2]}` : null;
}

/** Rating written inside an amateur name ("2162 Some Player"), split off when no Elo tag exists. */
function splitRatingFromName(name: string): { name: string; rating: number } | null {
  const m = /^(\d{3,4})\s+(.*\p{L}.*)$/u.exec(name.trim());
  if (!m) return null;
  const rating = Number(m[1]);
  return rating >= 600 && rating <= 3000 ? { name: m[2]!.trim(), rating } : null;
}

/** Draw / decisive termination from the free-text Termination tag, when it is more precise. */
function refineTermination(current: Termination, terminationTag: string | null, draw: boolean): Termination {
  if (!terminationTag || (current !== 'agreement' && current !== 'resign')) return current;
  const t = terminationTag.toLowerCase();
  if (draw && /repetition/.test(t)) return 'repetition';
  if (draw && /fifty|50[- ]?move/.test(t)) return 'fifty';
  if (/adjudicat/.test(t)) return 'other';
  return current;
}

/**
 * Maps a parsed PGN game to a reference game, or says why it is skipped (`pgnToNormalizedGame`'s
 * reasons plus `engine` and `unplayed`).
 */
export function toReferenceGame(
  pgn: PgnGame,
  ctx: { databaseId: Id; round?: RoundHints },
): ReferenceGame | { skip: ReferenceSkipReason; detail?: string } {
  const base = pgnToNormalizedGame(pgn, { origin: 'reference', databaseId: ctx.databaseId });
  if ('skip' in base) return base;
  const h = base.headers ?? {};
  if (base.white.title === 'BOT' || base.black.title === 'BOT') return { skip: 'engine' };
  const terminationTag = tag(h, 'Termination');
  if (terminationTag && /unplayed|forfeit/i.test(terminationTag)) return { skip: 'unplayed' };
  if (UNPLAYED_NAMES.test(base.white.name) || UNPLAYED_NAMES.test(base.black.name)) return { skip: 'unplayed' };

  const game: NormalizedGame = { ...base, white: { ...base.white }, black: { ...base.black } };
  for (const side of [game.white, game.black]) {
    if (side.rating !== null) continue;
    const split = splitRatingFromName(side.name);
    if (split) {
      side.name = split.name;
      side.rating = split.rating;
    }
  }
  game.termination = refineTermination(game.termination, terminationTag, game.result === '1/2-1/2');

  const gameUrl = tag(h, 'GameURL');
  const chapterKey = broadcastChapterKey(gameUrl) ?? broadcastChapterKey(tag(h, 'Site'));
  const broadcastName = tag(h, 'BroadcastName');
  const isBroadcast = chapterKey !== null || broadcastName !== null || ctx.round !== undefined;
  if (isBroadcast) {
    game.event = broadcastName ?? ctx.round?.tourName ?? game.event;
    if (gameUrl && /^https:\/\//.test(gameUrl)) game.url = gameUrl;
    const tc = otbTimeControl(tag(h, 'TimeControl'), {
      fideTC: ctx.round?.fideTC ?? null,
      names: [broadcastName, ctx.round?.tourName, tag(h, 'Event')],
    });
    game.timeClass = tc.timeClass;
    game.timeControl = tc.timeControl;
    if (game.endedAt === null && ctx.round?.startsAt) {
      game.startedAt = ctx.round.startsAt;
      game.endedAt = ctx.round.startsAt;
    }
  }

  const fed = (color: 'White' | 'Black', fideId: string | null): string | null => {
    const v = tag(h, `${color}Fed`)?.toUpperCase() ?? (fideId ? ctx.round?.federations?.get(fideId) : undefined) ?? null;
    return v && FED_RE.test(v) ? v : null;
  };
  return {
    game,
    chapterKey,
    federations: { white: fed('White', game.white.fideId), black: fed('Black', game.black.fideId) },
  };
}
