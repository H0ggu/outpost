/**
 * Display formatting for the library pages: dates in the viewer's zone (or UTC, per prefs),
 * relative times, clocks, results, scores and source kinds. Pure functions, no React.
 */
import type { EpochMs, GameResult, SourceKind } from '@outpost/shared/api';

const DAY_MS = 86_400_000;

/**
 * Dates are written the same way on every page, whatever the browser's language: day month
 * year and a 24-hour clock, as the profile and account pages write them (en-GB).
 */
export const DATE_LOCALE = 'en-GB';

/** Date only, e.g. "23 Nov 2026". `—` when unknown. */
export function formatDate(ms: EpochMs | null | undefined, utc = false): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  return new Intl.DateTimeFormat(DATE_LOCALE, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    ...(utc ? { timeZone: 'UTC' } : {}),
  }).format(ms);
}

/** Date and time, e.g. "23 Nov 2026, 14:05" (", 14:05 UTC" in UTC). */
export function formatDateTime(ms: EpochMs | null | undefined, utc = false): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  return new Intl.DateTimeFormat(DATE_LOCALE, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    ...(utc ? { timeZone: 'UTC', timeZoneName: 'short' } : {}),
  }).format(ms);
}

/** "just now", "5 minutes ago", "yesterday", "3 days ago", then the date. */
export function timeAgo(ms: EpochMs | null | undefined, now: number = Date.now()): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return 'never';
  const diff = now - ms;
  if (diff < 0) return formatDate(ms);
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  const sec = Math.round(diff / 1000);
  if (sec < 45) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return rtf.format(-min, 'minute');
  const hours = Math.round(min / 60);
  if (hours < 24) return rtf.format(-hours, 'hour');
  const days = Math.round(diff / DAY_MS);
  if (days < 30) return rtf.format(-days, 'day');
  return formatDate(ms);
}

/** Remaining clock time: `1:05:09` with hours, else `4:07`; null → ''. Negative values clamp to 0. */
export function formatClock(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '';
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** `1-0`, `0-1`, `½-½` (or `*` for a running game). */
export const resultLabel = (r: GameResult | '*'): string => (r === '1/2-1/2' ? '½-½' : r);

/** One side's points in a result: `1`, `0`, `½`, or '' while running. */
export function sideScore(r: GameResult | '*', side: 'white' | 'black'): string {
  if (r === '*') return '';
  if (r === '1/2-1/2') return '½';
  return (r === '1-0') === (side === 'white') ? '1' : '0';
}

/** Score in [0,1] as a whole percentage, e.g. `54%`; null → `—`. */
export const percent = (score: number | null | undefined): string =>
  score === null || score === undefined || !Number.isFinite(score) ? '—' : `${Math.round(score * 100)}%`;

/** Compact counts: 950, 12.3K, 4.1M (lila explorer style). */
export function compactNumber(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '')}K`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

/** Thousands separators, e.g. 12,345. */
export const fullNumber = (n: number): string => new Intl.NumberFormat('en').format(n);

/** "1 game", "12 games". */
export const plural = (n: number, one: string, many = `${one}s`): string => `${fullNumber(n)} ${n === 1 ? one : many}`;

/** Human name of a source kind. */
export const SOURCE_KIND_LABELS: Readonly<Record<SourceKind, string>> = {
  lichess: 'Lichess',
  chesscom: 'Chess.com',
  fide: 'FIDE',
  pgn: 'PGN',
};

/** Full moves from plies (rounded up). */
export const movesFromPlies = (plies: number): number => Math.ceil(plies / 2);
