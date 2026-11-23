/**
 * Formatting helpers of the account and admin pages: dates in the user's time-zone preference,
 * relative times, byte sizes, durations, and a short description of a browser's user agent.
 */
import { useMemo } from 'react';
import type { EpochMs, UserPrefs } from '@outpost/shared/api';
import { useSession } from '../../../api/hooks.ts';

/** `1.5 MB`, `812 kB`, `0 B` (SI units, like the server log). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '–';
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${i === 0 ? v : v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** `45s`, `12m 3s`, `3h 20m`, `4d 2h`. */
export function formatDuration(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

/** Thousands separators: `12,345`. */
export const formatCount = (n: number): string => n.toLocaleString('en-US');

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/** `just now`, `5 minutes ago`, `in 3 days`. */
export function relativeTime(t: EpochMs, now: EpochMs = Date.now()): string {
  const diff = (t - now) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return 'just now';
  const steps: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['minute', 60],
    ['hour', 3600],
    ['day', 86_400],
    ['week', 604_800],
    ['month', 2_629_800],
    ['year', 31_557_600],
  ];
  let unit: [Intl.RelativeTimeFormatUnit, number] = steps[0]!;
  for (const step of steps) if (abs >= step[1] * 0.9) unit = step;
  return rtf.format(Math.round(diff / unit[1]), unit[0]);
}

/** Date formatters honouring the `timezone` preference (`local` = the browser's zone). */
export interface TimeFormat {
  /** IANA zone used, or undefined for the browser's. */
  timeZone: string | undefined;
  /** `23 Nov 2026, 14:05` (+ ` UTC` in UTC mode). */
  dateTime: (t: EpochMs) => string;
  /** `23 Nov 2026`. */
  date: (t: EpochMs) => string;
}

/** Formatters for a time-zone preference. */
export function timeFormat(tz: UserPrefs['timezone']): TimeFormat {
  const timeZone = tz === 'utc' ? 'UTC' : undefined;
  const dt = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone });
  const d = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone });
  return {
    timeZone,
    dateTime: t => `${dt.format(t)}${timeZone ? ' UTC' : ''}`,
    date: t => d.format(t),
  };
}

/** `timeFormat` for the signed-in user's preference (local time for visitors). */
export function useTimeFormat(): TimeFormat {
  const tz = useSession().data?.user?.prefs.timezone ?? 'local';
  return useMemo(() => timeFormat(tz), [tz]);
}

/** `Firefox on macOS`, `Safari on iPhone`, `curl`; null when unknown. */
export function describeUserAgent(ua: string | null): string | null {
  if (!ua) return null;
  const browser =
    /Edg(?:A|iOS)?\//.test(ua)
      ? 'Edge'
      : /OPR\/|Opera/.test(ua)
        ? 'Opera'
        : /Firefox\/|FxiOS\//.test(ua)
          ? 'Firefox'
          : /Chrome\/|CriOS\//.test(ua)
            ? 'Chrome'
            : /Safari\//.test(ua)
              ? 'Safari'
              : /^curl\//.test(ua)
                ? 'curl'
                : null;
  const os = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Mac OS X|Macintosh/.test(ua)
          ? 'macOS'
          : /Windows/.test(ua)
            ? 'Windows'
            : /CrOS/.test(ua)
              ? 'ChromeOS'
              : /Linux/.test(ua)
                ? 'Linux'
                : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? ua.split(/[\s/]/)[0] ?? null;
}

/** UTC hour → `09:00`. */
export const hourLabel = (h: number): string => `${String(h).padStart(2, '0')}:00`;

/** The local wall-clock hour for a UTC hour today (for "09:00 UTC = 10:00 here"). */
export function localHourOfUtc(h: number, now: Date = new Date()): number {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h));
  return d.getHours();
}
