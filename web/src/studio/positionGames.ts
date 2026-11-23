/**
 * Games at a position (PLAN §5 "games at a position"): the player explorer's "All N games" button
 * (scripts/lila-patches/002 `showGames`) lists every game of the explored player that reaches the
 * board's position, a page at a time, from `GET /api/explorer/games`, with the explorer's own
 * restrictions (lila's speeds, modes and months, plus the profile's filters when the Studio was
 * opened with them), so the list holds exactly the games the explorer counts.
 *
 * No lila import: the request is a structural copy of lila's `ExplorerGamesRequest` (patch 002).
 */
import { INITIAL_FEN, makeFen, parseFen } from 'chessops/fen';
import { makeSanAndPlay } from 'chessops/san';
import { setupPosition } from 'chessops/variant';
import { Chess } from 'chessops/chess';
import type { Color, DbGameRow, ExplorerGamesPage, GameRow } from '@outpost/shared/api';
import { parseStdUci, stdUci } from '@outpost/shared/chess';
import { decodeFiltersSegment, filtersToQuery, MAX_LINE_PLIES } from '@outpost/shared/filters';

/** What the explorer asks for (lila's `ExplorerGamesRequest`, patch 002). */
export interface PositionGamesRequest {
  /** Player spec (profile slug, `lichess:…`, `chesscom:…`, `db:…`, `ref:…`). */
  player: string;
  color: Color;
  /** The board's first position and the moves from it (UCI), as lila sends them to the explorer. */
  rootFen: string;
  play: string[];
  /** The position itself. */
  fen: string;
  speeds: string[];
  modes: string[];
  /** `YYYY-MM` or ''. */
  since: string;
  until: string;
  /** Games the explorer counted there (its `games`). */
  total: number;
}

/** Games per page of the list. */
export const POSITION_GAMES_PAGE = 30;

/**
 * `GET /api/explorer/games` query for a request: the filters of `segment` (the profile the Studio
 * was opened with; none for other players) with the explorer's colour, lila's restrictions as the
 * player explorer receives them, and the page.
 */
export function positionGamesQuery(req: PositionGamesRequest, segment: string | undefined, page: number, pageSize = POSITION_GAMES_PAGE): URLSearchParams {
  let filters = {};
  if (segment) {
    try {
      filters = decodeFiltersSegment(segment, 'lenient');
    } catch {
      // an unreadable segment: the explorer ignored it too (query.ts drops it)
    }
  }
  const q = filtersToQuery({ ...filters, color: req.color });
  q.set('player', req.player);
  q.set('fen', req.rootFen);
  if (req.play.length) q.set('play', req.play.join(','));
  if (req.speeds.length) q.set('speeds', req.speeds.join(','));
  if (req.modes.length) q.set('modes', req.modes.join(','));
  if (req.since) q.set('since', req.since);
  if (req.until) q.set('until', req.until);
  q.set('page', String(page));
  q.set('pageSize', String(pageSize));
  return q;
}

/** The moves from `rootFen` as numbered SAN (`1. e4 c5`, `12... Nf6` from a set-up position); null if unreadable. */
export function sanOfLine(rootFen: string, play: readonly string[]): string | null {
  const setup = parseFen(rootFen);
  if (setup.isErr) return null;
  const pos = setupPosition('chess', setup.value);
  if (pos.isErr) return null;
  const board = pos.value;
  const parts: string[] = [];
  for (const [i, uci] of play.entries()) {
    const move = parseStdUci(board, uci);
    if (!move) return null;
    const white = board.turn === 'white';
    if (white) parts.push(`${board.fullmoves}.`);
    else if (i === 0) parts.push(`${board.fullmoves}...`);
    parts.push(makeSanAndPlay(board, move));
  }
  return parts.join(' ');
}

/**
 * The moves as a `line` filter (standard-castling UCI from the initial position, PLAN §6), or null
 * when the board doesn't start there, a move is illegal or the line is longer than the positions
 * Outpost indexes (`MAX_LINE_PLIES`).
 */
export function lineFilterOf(rootFen: string, play: readonly string[]): string[] | null {
  if (play.length > MAX_LINE_PLIES) return null;
  const setup = parseFen(rootFen);
  if (setup.isErr || makeFen(setup.value) !== INITIAL_FEN) return null;
  const pos = Chess.default();
  const line: string[] = [];
  for (const uci of play) {
    const move = parseStdUci(pos, uci);
    if (!move) return null;
    line.push(stdUci(pos, move));
    pos.play(move);
  }
  return line;
}

/** A loaded list (`StudioCtrl.positionGames`). */
export interface PositionGamesState {
  req: PositionGamesRequest;
  /** Display name of the player. */
  label: string;
  /** The moves as numbered SAN (null when they can't be read). */
  san: string | null;
  status: 'loading' | 'ready' | 'error';
  error?: string;
  /** The server's total (null until the first page arrived). */
  total: number | null;
  /** Pages loaded so far. */
  pages: number;
  rows: { perspective: 'player'; games: GameRow[] } | { perspective: 'neutral'; games: DbGameRow[] };
}

/** Appends a page to the rows (a page of the other perspective replaces them). */
export function appendPage(state: PositionGamesState, page: ExplorerGamesPage): PositionGamesState['rows'] {
  if (page.perspective === 'player')
    return { perspective: 'player', games: state.rows.perspective === 'player' ? [...state.rows.games, ...page.games] : page.games };
  return { perspective: 'neutral', games: state.rows.perspective === 'neutral' ? [...state.rows.games, ...page.games] : page.games };
}
