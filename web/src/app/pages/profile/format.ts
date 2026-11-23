/**
 * Formatting helpers for the profile pages: numbers, scores, dates in the viewer's time zone,
 * time controls, terminations and UCI lines as SAN (chessops).
 */
import { Chess } from 'chessops/chess';
import { makeSanAndPlay, parseSan } from 'chessops/san';
import {
  parseStdUci,
  parseTimeControl,
  stdUci,
  type Outcome,
  type Termination,
  type TimeClass,
} from '@outpost/shared/chess';
import { MAX_LINE_PLIES, type OppStrength, type Period } from '@outpost/shared/filters';
import type { SourceKind, SyncState } from '@outpost/shared/api';

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

const intFmt = new Intl.NumberFormat('en-US');

/** `12345` → `12,345`. */
export const fmtInt = (n: number): string => intFmt.format(Math.round(n));

/** Compact counts: `1234` → `1.2K`, `987` → `987`. */
export const fmtCompact = (n: number): string => {
  if (Math.abs(n) < 10_000) return fmtInt(n);
  if (Math.abs(n) < 1_000_000) return `${(n / 1000).toFixed(n < 100_000 ? 1 : 0).replace(/\.0$/, '')}K`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
};

/** A share in [0, 1] as a whole percentage (`0.537` → `54%`); `–` for null. */
export const fmtPct = (x: number | null | undefined, digits = 0): string =>
  x === null || x === undefined || Number.isNaN(x) ? '–' : `${(x * 100).toFixed(digits)}%`;

/** A percentage already in 0–100 (`BehaviourRow.pct`). */
export const fmtPct100 = (x: number): string => `${x < 10 && x > 0 ? x.toFixed(1) : Math.round(x)}%`;

/** Score rate of W/D/L counts, or null with no games. */
export const scoreOfWdl = (x: { w: number; d: number; l: number }): number | null => {
  const n = x.w + x.d + x.l;
  return n === 0 ? null : (x.w + x.d / 2) / n;
};

/** Average full moves from plies (`avgPly` 41 → `21`). */
export const fmtMoves = (plies: number): string => fmtInt(Math.ceil(plies / 2));

/** Rating with an optional provisional mark. */
export const fmtRating = (r: number | null | undefined, provisional = false): string =>
  r === null || r === undefined ? '–' : `${Math.round(r)}${provisional ? '?' : ''}`;

/** Signed number (`+12`, `−8`, `0`). */
export const fmtSigned = (n: number): string => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '0');

// ---------------------------------------------------------------------------
// Dates and times
// ---------------------------------------------------------------------------

const dateFmts = new Map<string, Intl.DateTimeFormat>();

const dtf = (timeZone: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat => {
  const key = `${timeZone}|${JSON.stringify(opts)}`;
  let f = dateFmts.get(key);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-GB', { ...opts, timeZone });
    } catch {
      f = new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: 'UTC' });
    }
    dateFmts.set(key, f);
  }
  return f;
};

/** `12 Nov 2026`. */
export const fmtDate = (ms: number | null | undefined, timeZone: string): string =>
  ms === null || ms === undefined ? '–' : dtf(timeZone, { day: 'numeric', month: 'short', year: 'numeric' }).format(ms);

/** `12 Nov 2026, 14:05`. */
export const fmtDateTime = (ms: number | null | undefined, timeZone: string): string =>
  ms === null || ms === undefined
    ? '–'
    : dtf(timeZone, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);

/** `Nov 2026`. */
export const fmtMonth = (ms: number, timeZone: string): string => dtf(timeZone, { month: 'short', year: 'numeric' }).format(ms);

/** A calendar date string `YYYY-MM-DD` as `Tue 12 Nov 2026` (no zone shift: it is already a day). */
export const fmtIsoDay = (iso: string): string => {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return dtf('UTC', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(Date.UTC(y, m - 1, d));
};

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/** `3 hours ago`, `yesterday`, `in 5 minutes`. */
export const fmtRelative = (ms: number | null | undefined, now: number = Date.now()): string => {
  if (ms === null || ms === undefined) return 'never';
  const diff = ms - now;
  const abs = Math.abs(diff);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 365 * 86_400_000],
    ['month', 30 * 86_400_000],
    ['week', 7 * 86_400_000],
    ['day', 86_400_000],
    ['hour', 3_600_000],
    ['minute', 60_000],
  ];
  for (const [unit, size] of units) if (abs >= size) return rtf.format(Math.round(diff / size), unit);
  return 'just now';
};

/** Countdown text: `4:05`, `1:02:03`. */
export const fmtCountdown = (ms: number): string => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
};

/** Hour label `00`–`23`. */
export const fmtHour = (h: number): string => String(h).padStart(2, '0');

/** Weekday names, Monday first (the activity endpoint's order). */
export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;
export const WEEKDAYS_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

// ---------------------------------------------------------------------------
// Chess vocabulary
// ---------------------------------------------------------------------------

/** Human time control: `180+2` → `3+2`, `1/259200` → `3 days`, `–` when unknown. */
export const fmtTimeControl = (tc: string | null | undefined): string => {
  const p = parseTimeControl(tc);
  if (p === null) return '–';
  if (p === 'correspondence') {
    const m = /^\d+\/(\d+)$/.exec(tc?.trim() ?? '');
    const days = m ? Math.round(Number(m[1]) / 86_400) : null;
    return days ? `${days} day${days === 1 ? '' : 's'}` : 'Corresp.';
  }
  const mins = p.initial / 60;
  const base = Number.isInteger(mins) ? String(mins) : mins === 0.25 ? '¼' : mins === 0.5 ? '½' : mins === 0.75 ? '¾' : mins.toFixed(1);
  return `${base}+${p.increment}`;
};

/** Termination names (TERMINATIONS in shared/chess.ts). */
export const TERMINATION_LABELS: Readonly<Record<Termination, string>> = {
  mate: 'Checkmate',
  resign: 'Resignation',
  timeout: 'Time out',
  abandon: 'Abandoned',
  agreement: 'Agreement',
  repetition: 'Repetition',
  stalemate: 'Stalemate',
  insufficient: 'Insufficient material',
  fifty: '50-move rule',
  timeout_vs_insufficient: 'Time out vs insufficient material',
  other: 'Other',
};

/** Outcome names from the profile player's side. */
export const OUTCOME_LABELS: Readonly<Record<Outcome, string>> = { w: 'Win', d: 'Draw', l: 'Loss' };
export const OUTCOME_PLURAL: Readonly<Record<Outcome, string>> = { w: 'Wins', d: 'Draws', l: 'Losses' };

/** Source kinds as site names. */
export const SOURCE_KIND_LABELS: Readonly<Record<SourceKind, string>> = {
  lichess: 'Lichess',
  chesscom: 'Chess.com',
  fide: 'FIDE (reference DB)',
  pgn: 'PGN database',
};

/** Period presets as labels. */
export const PERIOD_LABELS: Readonly<Record<Period, string>> = {
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '3m': 'Last 3 months',
  '6m': 'Last 6 months',
  '12m': 'Last 12 months',
};

/** Opponent strength buckets (relative to the player's rating). */
export const OPP_LABELS: Readonly<Record<OppStrength, string>> = {
  '-200': 'Weaker by 200+',
  '-100': 'Weaker by 100+',
  eq: 'Similar (±100)',
  '100': 'Stronger by 100+',
  '200': 'Stronger by 200+',
};

/** Sync states as words. */
export const SYNC_STATE_LABELS: Readonly<Record<SyncState, string>> = {
  never: 'Not synced yet',
  queued: 'Queued',
  running: 'Updating',
  idle: 'Synced',
  error: 'Sync failed',
};

/** Time classes a player actually plays (everything but `unknown`), for pickers. */
export const PLAYABLE_TIME_CLASSES: readonly TimeClass[] = ['bullet', 'blitz', 'rapid', 'classical', 'correspondence'];

// ---------------------------------------------------------------------------
// Lines (UCI csv ↔ SAN)
// ---------------------------------------------------------------------------

/** A UCI line (array or csv) as SAN moves, or null when a move is illegal from the start position. */
export function lineToSanMoves(line: readonly string[] | string): string[] | null {
  const moves = typeof line === 'string' ? line.split(',').filter(Boolean) : line;
  const pos = Chess.default();
  const out: string[] = [];
  for (const uci of moves) {
    const move = parseStdUci(pos, uci);
    if (!move) return null;
    out.push(makeSanAndPlay(pos, move));
  }
  return out;
}

/** SAN moves with move numbers: `1. e4 e5 2. Nf3`. */
export const numberedSan = (san: readonly string[]): string =>
  san.map((m, i) => (i % 2 === 0 ? `${i / 2 + 1}. ${m}` : m)).join(' ');

/** A UCI line as numbered SAN (`1. e4 c5`), falling back to the raw UCI if it is illegal. */
export function fmtLine(line: readonly string[] | string): string {
  const san = lineToSanMoves(line);
  if (san) return numberedSan(san);
  return (typeof line === 'string' ? line.split(',') : line).join(' ');
}

/**
 * Parses typed moves (`1. e4 c5 2. Nf3`, `e4 c5 Nf3`, or UCI `e2e4 c7c5`) into a UCI line in
 * standard castling notation. Returns the line, or the first token that isn't a legal move.
 */
export function parseMovesInput(text: string): { line: string[] } | { error: string } {
  const tokens = text
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/\d+\.(\.\.)?/g, ' ')
    .replace(/(1-0|0-1|1\/2-1\/2|\*)\s*$/, ' ')
    .split(/[\s,]+/)
    .filter(Boolean);
  if (tokens.length === 0) return { error: 'Enter some moves' };
  if (tokens.length > MAX_LINE_PLIES) return { error: `At most ${MAX_LINE_PLIES} moves (plies)` };
  const pos = Chess.default();
  const line: string[] = [];
  for (const raw of tokens) {
    const token = raw.replace(/[!?+#]+$/, '').replace(/^0-0-0$/, 'O-O-O').replace(/^0-0$/, 'O-O');
    const move = parseSan(pos, token) ?? parseStdUci(pos, token.toLowerCase());
    if (!move) return { error: `Illegal or unknown move: ${raw}` };
    line.push(stdUci(pos, move));
    pos.play(move);
  }
  return { line };
}
