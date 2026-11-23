/**
 * Studio query parameters (PLAN §8.4, `StudioQuery` in src/app/paths.ts):
 *   ?game=<id|op<id>>  open a stored game (GET /api/games/:id); with ?fen=, at the first ply reaching it
 *   ?file=<id>         open a My Files file
 *   ?pgn=<text>        open PGN text
 *   ?fen=<fen>         set up a position
 *   ?explorer=masters|lichess|reference|player:<spec>  open the opening explorer on that database
 *   ?color=white|black player explorer side (and board orientation for ?game)
 *   ?filters=<segment> Outpost filters (encodeFiltersSegment) for the player explorer
 *   ?embed=explorer    minimal chrome, for the profile Explorer tab iframe
 * Invalid values are ignored, never fatal; an invalid `?fen=` is reported (`badFen`), like a game
 * or file that can't be opened.
 */
import { parseFen } from 'chessops/fen';
import { fromExplorerGameId, type Color, type Id } from '@outpost/shared/api';
import { decodeFiltersSegment, EMPTY_FILTERS_SEGMENT, parsePlayerSpec } from '@outpost/shared/filters';

/** Which explorer database to open. */
export type StudioExplorer = { db: 'masters' | 'lichess' | 'reference' } | { db: 'player'; player: string };

/** Validated studio.html query. */
export interface StudioParams {
  game?: Id;
  file?: Id;
  pgn?: string;
  fen?: string;
  /** A `?fen=` that isn't a position (shown to the user once the Studio is up). */
  badFen?: string;
  explorer?: StudioExplorer;
  color?: Color;
  /** A decodable filters segment (never `_`, which means no filters). */
  filters?: string;
  embed: boolean;
}

const MAX_PGN = 200_000;

const rowId = (s: string | null): Id | undefined =>
  s !== null && /^[1-9]\d{0,15}$/.test(s) ? Number(s) : undefined;

/** A game id as Outpost (`123`) or the explorer (`op123`) writes it. */
const gameId = (s: string | null): Id | undefined => (s === null ? undefined : (fromExplorerGameId(s) ?? rowId(s)));

/** Normalises a FEN typed with `_` for spaces (lila's URL style) and checks it parses. */
export function cleanFen(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const fen = raw.trim().replace(/_/g, ' ').replace(/\s+/g, ' ');
  if (fen.length > 120) return undefined;
  return parseFen(fen).isOk ? fen : undefined;
}

/** Parses `location.search`. */
export function parseStudioQuery(search: string | URLSearchParams): StudioParams {
  const q = typeof search === 'string' ? new URLSearchParams(search) : search;
  const out: StudioParams = { embed: q.get('embed') === 'explorer' };

  const game = gameId(q.get('game'));
  if (game !== undefined) out.game = game;
  const file = rowId(q.get('file'));
  if (file !== undefined) out.file = file;

  const pgn = q.get('pgn');
  if (pgn && pgn.trim() && pgn.length <= MAX_PGN) out.pgn = pgn;
  const rawFen = q.get('fen');
  const fen = cleanFen(rawFen);
  if (fen) out.fen = fen;
  else if (rawFen?.trim()) out.badFen = rawFen.trim().slice(0, 120);

  const color = q.get('color');
  if (color === 'white' || color === 'black') out.color = color;

  const explorer = q.get('explorer');
  if (explorer === 'masters' || explorer === 'lichess' || explorer === 'reference') out.explorer = { db: explorer };
  else if (explorer?.startsWith('player:')) {
    const player = explorer.slice('player:'.length);
    if (parsePlayerSpec(player)) out.explorer = { db: 'player', player };
  }

  const filters = q.get('filters');
  if (filters && filters !== EMPTY_FILTERS_SEGMENT) {
    try {
      decodeFiltersSegment(filters, 'strict');
      out.filters = filters;
    } catch {
      // invalid filters: the explorer opens unfiltered
    }
  }
  return out;
}
