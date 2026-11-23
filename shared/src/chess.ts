/**
 * Pure chess-domain helpers shared by the server and the web app.
 *
 * Sources: docs/research/chesscom-api.md §2 (result codes, time classes),
 * docs/research/lichess-api.md §1 (speeds, statuses), docs/research/web-libs.md §2 (castling UCI).
 * Everything here is deterministic and side-effect free; keep it that way.
 */
import { castlingSide, normalizeMove, type Position } from 'chessops/chess';
import { makeFen } from 'chessops/fen';
import type { Move } from 'chessops/types';
import { kingCastlesTo, makeUci, parseUci } from 'chessops/util';

// ---------------------------------------------------------------------------
// Core unions
// ---------------------------------------------------------------------------

/** Side colour, spelled like chessops and chessground. */
export type Color = 'white' | 'black';

/** Single-letter colour as stored in `player_games.color`. */
export type ColorChar = 'w' | 'b';

/** All time classes, in display order. `unknown` covers PGN games without a usable TimeControl. */
export const TIME_CLASSES = ['bullet', 'blitz', 'rapid', 'classical', 'correspondence', 'unknown'] as const;
/** Time class of a game (UltraBullet is folded into bullet, Chess.com daily into correspondence). */
export type TimeClass = (typeof TIME_CLASSES)[number];

/** Win, draw or loss from one player's point of view. */
export const OUTCOMES = ['w', 'd', 'l'] as const;
/** Outcome from one player's point of view. */
export type Outcome = (typeof OUTCOMES)[number];

/** PGN game results that Outpost stores (unfinished games are never stored). */
export const GAME_RESULTS = ['1-0', '0-1', '1/2-1/2'] as const;
/** PGN game result. */
export type GameResult = (typeof GAME_RESULTS)[number];

/** How a game ended (PLAN §4, `games.termination`). */
export const TERMINATIONS = [
  'mate',
  'resign',
  'timeout',
  'abandon',
  'agreement',
  'repetition',
  'stalemate',
  'insufficient',
  'fifty',
  'timeout_vs_insufficient',
  'other',
] as const;
/** How a game ended. */
export type Termination = (typeof TERMINATIONS)[number];

/** Player titles seen on Lichess and Chess.com (LM and BOT are Lichess-only). */
export const TITLES = ['GM', 'WGM', 'IM', 'WIM', 'FM', 'WFM', 'CM', 'WCM', 'NM', 'WNM', 'LM', 'BOT'] as const;
/** Player title. */
export type Title = (typeof TITLES)[number];

/** True when `s` is a known title. */
export const isTitle = (s: unknown): s is Title => typeof s === 'string' && (TITLES as readonly string[]).includes(s);

/** `'white' | 'black'` to `'w' | 'b'`. */
export const colorChar = (c: Color): ColorChar => (c === 'white' ? 'w' : 'b');

/** `'w' | 'b'` to `'white' | 'black'`. */
export const colorFromChar = (c: ColorChar): Color => (c === 'w' ? 'white' : 'black');

/** The other colour. */
export const oppositeColor = (c: Color): Color => (c === 'white' ? 'black' : 'white');

// ---------------------------------------------------------------------------
// Results, outcomes and scores
// ---------------------------------------------------------------------------

/** Win/draw/loss counters. */
export interface Wdl {
  w: number;
  d: number;
  l: number;
}

/** A fresh zeroed counter. */
export const emptyWdl = (): Wdl => ({ w: 0, d: 0, l: 0 });

/** Total number of games in a counter. */
export const wdlTotal = (x: Wdl): number => x.w + x.d + x.l;

/** Points for one outcome: 1, ½ or 0. */
export const scoreOf = (o: Outcome): 1 | 0.5 | 0 => (o === 'w' ? 1 : o === 'd' ? 0.5 : 0);

/** Score rate in [0, 1] — (wins + draws/2) / games — or null when there are no games. */
export const scoreRate = (x: Wdl): number | null => {
  const n = wdlTotal(x);
  return n === 0 ? null : (x.w + x.d / 2) / n;
};

/** Parses a PGN result tag. Accepts `½-½`; returns null for `*` and anything unknown. */
export const parseResult = (s: string | null | undefined): GameResult | null => {
  switch (s?.trim()) {
    case '1-0':
      return '1-0';
    case '0-1':
      return '0-1';
    case '1/2-1/2':
    case '½-½':
      return '1/2-1/2';
    default:
      return null;
  }
};

/** The winning colour of a result, or null for a draw. */
export const winnerOf = (r: GameResult): Color | null => (r === '1-0' ? 'white' : r === '0-1' ? 'black' : null);

/** The result for a winner (null means draw). */
export const resultFromWinner = (winner: Color | null | undefined): GameResult =>
  winner === 'white' ? '1-0' : winner === 'black' ? '0-1' : '1/2-1/2';

/** Outcome of a game from `color`'s point of view. */
export const outcomeFor = (result: GameResult, color: Color): Outcome => {
  const winner = winnerOf(result);
  return winner === null ? 'd' : winner === color ? 'w' : 'l';
};

// ---------------------------------------------------------------------------
// Lichess
// ---------------------------------------------------------------------------

/** Lichess speeds for standard chess (`game.speed`). */
export type LichessSpeed = 'ultraBullet' | 'bullet' | 'blitz' | 'rapid' | 'classical' | 'correspondence';

/** Lichess `game.status` values (docs/research/lichess-api.md §1). */
export type LichessStatus =
  | 'created'
  | 'started'
  | 'aborted'
  | 'mate'
  | 'resign'
  | 'stalemate'
  | 'timeout'
  | 'draw'
  | 'outoftime'
  | 'cheat'
  | 'noStart'
  | 'unknownFinish'
  | 'insufficientMaterialClaim'
  | 'variantEnd';

/** Lichess speed to time class. UltraBullet counts as bullet (PLAN §7). */
export const lichessSpeedToTimeClass = (speed: string | null | undefined): TimeClass => {
  switch (speed) {
    case 'ultraBullet':
    case 'bullet':
      return 'bullet';
    case 'blitz':
    case 'rapid':
    case 'classical':
    case 'correspondence':
      return speed;
    default:
      return 'unknown';
  }
};

/**
 * Lichess status to termination.
 * - `timeout` on Lichess means a player left and the opponent claimed the win, so it maps to `abandon`;
 *   running out of time is `outoftime`, which is a draw (`timeout_vs_insufficient`) when there is no winner.
 * - `draw` covers agreement as well as claimed repetition / 50-move draws; the API cannot tell them apart,
 *   so it maps to `agreement` unless the caller detects repetition or the 50-move rule from the moves.
 */
export const lichessStatusToTermination = (status: string, winner: Color | null | undefined): Termination => {
  switch (status) {
    case 'mate':
      return 'mate';
    case 'resign':
      return 'resign';
    case 'stalemate':
      return 'stalemate';
    case 'timeout':
    case 'noStart':
      return 'abandon';
    case 'outoftime':
      return winner ? 'timeout' : 'timeout_vs_insufficient';
    case 'draw':
      return 'agreement';
    case 'insufficientMaterialClaim':
      return 'insufficient';
    default:
      return 'other';
  }
};

/** Result of a finished Lichess game, or null when it has none (aborted, still running). */
export const lichessResult = (status: string, winner: Color | null | undefined): GameResult | null => {
  if (status === 'created' || status === 'started' || status === 'aborted') return null;
  if (winner) return resultFromWinner(winner);
  return status === 'cheat' || status === 'unknownFinish' || status === 'variantEnd' ? null : '1/2-1/2';
};

// ---------------------------------------------------------------------------
// Chess.com
// ---------------------------------------------------------------------------

/** Chess.com result code meaning a win. */
export const CHESSCOM_WIN_CODES = ['win'] as const;
/** Chess.com result codes meaning a draw. */
export const CHESSCOM_DRAW_CODES = [
  'agreed',
  'repetition',
  'stalemate',
  'insufficient',
  '50move',
  'timevsinsufficient',
] as const;
/** Chess.com result codes meaning a loss. */
export const CHESSCOM_LOSS_CODES = [
  'checkmated',
  'timeout',
  'resigned',
  'lose',
  'abandoned',
  'kingofthehill',
  'threecheck',
  'bughousepartnerlose',
] as const;
/** Any documented Chess.com per-player result code (`white.result` / `black.result`). */
export type ChesscomResultCode =
  | (typeof CHESSCOM_WIN_CODES)[number]
  | (typeof CHESSCOM_DRAW_CODES)[number]
  | (typeof CHESSCOM_LOSS_CODES)[number];

const CC_DRAW = new Set<string>(CHESSCOM_DRAW_CODES);
const CC_KNOWN = new Set<string>([...CHESSCOM_WIN_CODES, ...CHESSCOM_DRAW_CODES, ...CHESSCOM_LOSS_CODES]);

/** True for documented Chess.com result codes. Unknown codes should be logged by the importer. */
export const isKnownChesscomCode = (code: string): code is ChesscomResultCode => CC_KNOWN.has(code);

/** Chess.com `time_class` to time class; `daily` is correspondence. Use the field as given (PLAN §7). */
export const chesscomTimeClass = (tc: string | null | undefined): TimeClass => {
  switch (tc) {
    case 'daily':
      return 'correspondence';
    case 'rapid':
    case 'blitz':
    case 'bullet':
      return tc;
    default:
      return 'unknown';
  }
};

/** A player's own Chess.com result code to W/D/L. Unknown codes count as a loss (research §2). */
export const chesscomOutcome = (code: string): Outcome => (code === 'win' ? 'w' : CC_DRAW.has(code) ? 'd' : 'l');

/** Game result from both players' Chess.com codes, or null if they are inconsistent. */
export const chesscomResult = (whiteCode: string, blackCode: string): GameResult | null => {
  const w = chesscomOutcome(whiteCode);
  const b = chesscomOutcome(blackCode);
  if (w === 'w' && b === 'l') return '1-0';
  if (w === 'l' && b === 'w') return '0-1';
  if (w === 'd' && b === 'd') return '1/2-1/2';
  return null;
};

/** Termination from both players' Chess.com codes (the loser's code, or the shared draw code). */
export const chesscomTermination = (whiteCode: string, blackCode: string): Termination => {
  const loser = whiteCode === 'win' ? blackCode : blackCode === 'win' ? whiteCode : null;
  if (loser !== null) {
    switch (loser) {
      case 'checkmated':
        return 'mate';
      case 'resigned':
        return 'resign';
      case 'timeout':
        return 'timeout';
      case 'abandoned':
        return 'abandon';
      default:
        return 'other';
    }
  }
  const drawCode = CC_DRAW.has(whiteCode) ? whiteCode : blackCode;
  switch (drawCode) {
    case 'agreed':
      return 'agreement';
    case 'repetition':
      return 'repetition';
    case 'stalemate':
      return 'stalemate';
    case 'insufficient':
      return 'insufficient';
    case '50move':
      return 'fifty';
    case 'timevsinsufficient':
      return 'timeout_vs_insufficient';
    default:
      return 'other';
  }
};

// ---------------------------------------------------------------------------
// Time controls (PGN `TimeControl`, Chess.com `time_control`)
// ---------------------------------------------------------------------------

/** A clock in seconds. */
export interface ClockSpec {
  initial: number;
  increment: number;
}

/**
 * Parses a PGN-style time control: `180+2`, `600`, or `1/259200` (Chess.com daily, one move per N seconds).
 * Returns `'correspondence'` for daily / `N/secs` forms, null for `-`, `?` and anything unparseable.
 */
export const parseTimeControl = (tc: string | null | undefined): ClockSpec | 'correspondence' | null => {
  const s = tc?.trim();
  if (!s || s === '-' || s === '?') return null;
  if (/^\d+\/\d+$/.test(s)) return 'correspondence';
  const m = /^(\d+)(?:\+(\d+))?$/.exec(s);
  if (!m) return null;
  return { initial: Number(m[1]), increment: Number(m[2] ?? 0) };
};

/**
 * Time class from a clock, using Lichess's thresholds on the estimated duration
 * `initial + 40 × increment`: under 3 min bullet, under 8 blitz, under 25 rapid, otherwise classical.
 */
export const timeClassFromClock = (clock: ClockSpec): TimeClass => {
  const est = clock.initial + 40 * clock.increment;
  if (est < 180) return 'bullet';
  if (est < 480) return 'blitz';
  if (est < 1500) return 'rapid';
  return 'classical';
};

/** Time class from a PGN `TimeControl` tag (`unknown` when missing). For PGN and reference imports. */
export const timeClassFromTimeControl = (tc: string | null | undefined): TimeClass => {
  const p = parseTimeControl(tc);
  if (p === null) return 'unknown';
  if (p === 'correspondence') return 'correspondence';
  return timeClassFromClock(p);
};

// ---------------------------------------------------------------------------
// Moves, UCI and positions
// ---------------------------------------------------------------------------

/** Matches one UCI move in standard chess (`e2e4`, `e7e8q`). */
export const UCI_RE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

/** True when `s` looks like a UCI move. */
export const isUci = (s: string): boolean => UCI_RE.test(s);

/**
 * UCI for a move in **standard castling notation** (`e1g1`, not chessops' king-takes-rook `e1h1`).
 * Use this for `positions.next_uci`, explorer `uci` fields and engine input. `pos` is the position
 * before the move.
 */
export const stdUci = (pos: Position, move: Move): string => {
  const side = castlingSide(pos, move);
  return side && 'from' in move ? makeUci({ from: move.from, to: kingCastlesTo(pos.turn, side) }) : makeUci(move);
};

/**
 * Parses UCI in either castling notation (`e1g1` or `e1h1`) into a chessops move for `pos`,
 * or undefined when it is malformed or illegal.
 */
export const parseStdUci = (pos: Position, uci: string): Move | undefined => {
  const raw = parseUci(uci);
  if (!raw) return undefined;
  const move = normalizeMove(pos, raw);
  return pos.isLegal(move) ? move : undefined;
};

/**
 * Transposition key text: chessops EPD (`board turn castling ep`), where the en-passant square is
 * only present when an en-passant capture is legal. `positions.pos_key` is derived from this
 * (server/src/chess/posKey.ts).
 */
export const epdOf = (pos: Position): string => makeFen(pos.toSetup(), { epd: true });

/**
 * Canonical lookup key for a player name or username: NFC, trimmed, lowercase.
 * Used for `sources.key` (Lichess/Chess.com usernames) and `games.white_key` / `black_key`.
 */
export const playerKey = (name: string): string => name.normalize('NFC').trim().toLowerCase();
