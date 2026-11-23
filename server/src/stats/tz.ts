/**
 * IANA time-zone arithmetic for the activity buckets (PLAN §6 `activity?tz=`), on `Intl` only.
 *
 * SQLite knows nothing about zones, so the activity queries group games by UTC instant in buckets
 * that never straddle a local hour boundary or an offset change (`bucketSizeFor`), and this module
 * shifts each bucket by the zone's offset at that instant. DST and historical offset changes are
 * found by sampling the zone once a day and bisecting each change to the second; results are
 * cached per zone and year.
 */

/** Milliseconds in an hour and a day. */
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/** Floor division and a non-negative modulo (epoch ms can be negative for pre-1970 games). */
export const floorDiv = (a: number, b: number): number => Math.floor(a / b);
export const mod = (a: number, b: number): number => ((a % b) + b) % b;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      era: 'short',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    if (formatters.size > 500) formatters.clear();
    formatters.set(tz, f);
  }
  return f;
}

/** Longest accepted zone name. */
const MAX_TZ_LENGTH = 64;
/** IANA names (`Europe/Oslo`, `America/Argentina/Buenos_Aires`, `Etc/GMT+5`, `UTC`). */
const TZ_RE = /^[A-Za-z][A-Za-z0-9_+\-/]*$/;

/**
 * Current IANA names that ICU still treats as aliases of an older spelling (its canonical
 * `Asia/Calcutta` for `Asia/Kolkata`), so `Intl.supportedValuesOf` does not list them. Browsers
 * report these names, so they keep their own spelling.
 */
const CURRENT_IANA_NAMES = [
  'Africa/Asmara',
  'America/Argentina/Buenos_Aires',
  'America/Argentina/Catamarca',
  'America/Argentina/Cordoba',
  'America/Argentina/Jujuy',
  'America/Argentina/Mendoza',
  'America/Atikokan',
  'America/Indiana/Indianapolis',
  'America/Kentucky/Louisville',
  'America/Nuuk',
  'Asia/Ho_Chi_Minh',
  'Asia/Kathmandu',
  'Asia/Kolkata',
  'Asia/Yangon',
  'Atlantic/Faroe',
  'Europe/Kyiv',
  'Pacific/Chuuk',
  'Pacific/Kanton',
  'Pacific/Pohnpei',
] as const;

/** Lowercase zone name → its one spelling (built on first use). */
let zoneSpellings: Map<string, string> | null = null;

function spellingOf(lower: string): string | undefined {
  if (!zoneSpellings) {
    zoneSpellings = new Map();
    for (const name of [...Intl.supportedValuesOf('timeZone'), ...CURRENT_IANA_NAMES, 'UTC']) zoneSpellings.set(name.toLowerCase(), name);
  }
  return zoneSpellings.get(lower);
}

/**
 * The zone name to use for `tz`, or null when it is not an IANA zone this runtime knows. Every
 * casing of a name gives the same spelling: zones the runtime lists and current IANA names keep
 * their own (`europe/oslo` → `Europe/Oslo`, `ASIA/KOLKATA` → `Asia/Kolkata`); other aliases become
 * the zone ICU resolves them to (`us/eastern` → `America/New_York`). Raw offsets (`+05:30`) are
 * refused: the contract asks for an IANA zone.
 */
export function resolveTimeZone(tz: string): string | null {
  if (tz.length === 0 || tz.length > MAX_TZ_LENGTH || !TZ_RE.test(tz)) return null;
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
  return spellingOf(tz.toLowerCase()) ?? resolved;
}

/** UTC offset (ms, local − UTC) of `tz` at instant `t`. */
export function offsetAt(tz: string, t: number): number {
  const sec = Math.floor(t / 1000) * 1000;
  const parts = formatter(tz).formatToParts(new Date(sec));
  let year = 0;
  let month = 1;
  let day = 1;
  let hour = 0;
  let minute = 0;
  let second = 0;
  let bc = false;
  for (const p of parts) {
    switch (p.type) {
      case 'year':
        year = Number(p.value);
        break;
      case 'month':
        month = Number(p.value);
        break;
      case 'day':
        day = Number(p.value);
        break;
      case 'hour':
        hour = Number(p.value);
        break;
      case 'minute':
        minute = Number(p.value);
        break;
      case 'second':
        second = Number(p.value);
        break;
      case 'era':
        bc = p.value.startsWith('B');
        break;
      default:
        break;
    }
  }
  const d = new Date(0);
  d.setUTCFullYear(bc ? 1 - year : year, month - 1, day);
  d.setUTCHours(hour, minute, second, 0);
  return d.getTime() - sec;
}

/** An offset that applies from `start` (inclusive) until the next segment's start. */
export interface OffsetSegment {
  start: number;
  offset: number;
}

interface YearTransitions {
  /** Offset at the first instant of the year. */
  initial: number;
  /** Offset changes inside the year: `{start, offset}` = from `start` on, `offset` applies. */
  changes: OffsetSegment[];
}

const yearCache = new Map<string, YearTransitions>();
const YEAR_CACHE_MAX = 5000;

const yearStart = (year: number): number => {
  const d = new Date(0);
  d.setUTCFullYear(year, 0, 1);
  return d.getTime();
};

/** Offset changes of `tz` during one UTC calendar year (sampled daily, bisected to the second). */
function transitionsInYear(tz: string, year: number): YearTransitions {
  const key = `${tz}\u0000${year}`;
  const hit = yearCache.get(key);
  if (hit) return hit;
  const start = yearStart(year);
  const end = yearStart(year + 1);
  const initial = offsetAt(tz, start);
  const changes: OffsetSegment[] = [];
  let prevT = start;
  let prevOff = initial;
  for (let t = start + DAY_MS; ; t += DAY_MS) {
    const at = Math.min(t, end);
    const off = offsetAt(tz, at);
    if (off !== prevOff) {
      // Bisect (prevT, at] in whole seconds for the first instant with a different offset.
      let lo = prevT;
      let hi = at;
      while (hi - lo > 1000) {
        const mid = lo + Math.floor((hi - lo) / 2000) * 1000;
        if (offsetAt(tz, mid) === prevOff) lo = mid;
        else hi = mid;
      }
      changes.push({ start: hi, offset: offsetAt(tz, hi) });
      prevOff = off;
    }
    prevT = at;
    if (at >= end) break;
  }
  const result = { initial, changes };
  if (yearCache.size >= YEAR_CACHE_MAX) yearCache.clear();
  yearCache.set(key, result);
  return result;
}

/** UTC year of an instant. */
const utcYear = (t: number): number => new Date(t).getUTCFullYear();

/**
 * Offset segments of `tz` covering [from, to]: the first segment starts at `from`, later ones at
 * each offset change. Never empty.
 */
export function offsetSegments(tz: string, from: number, to: number): OffsetSegment[] {
  const segs: OffsetSegment[] = [{ start: from, offset: offsetAt(tz, from) }];
  for (let y = utcYear(from); y <= utcYear(to); y++) {
    for (const c of transitionsInYear(tz, y).changes) {
      if (c.start <= from || c.start > to) continue;
      if (c.offset !== segs[segs.length - 1]!.offset) segs.push(c);
    }
  }
  return segs;
}

const gcd = (a: number, b: number): number => {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) [x, y] = [y, x % y];
  return x;
};

/**
 * Largest bucket width (ms, divides an hour) such that UTC buckets `[k·w, (k+1)·w)` never straddle
 * an offset change or a local hour boundary: the gcd of an hour, every offset and every change
 * instant. One hour for most zones, 30 or 15 minutes for zones like Asia/Kolkata or Asia/Kathmandu,
 * down to a second for local mean time before standard time.
 */
export function bucketSizeFor(segs: readonly OffsetSegment[]): number {
  let g = HOUR_MS;
  for (const [i, s] of segs.entries()) {
    g = gcd(g, s.offset);
    if (i > 0) g = gcd(g, mod(s.start, HOUR_MS));
  }
  return Math.max(g, 1000);
}

/**
 * Offset lookup for ascending instants (a sweep over `segs`): call `at(t)` with non-decreasing `t`.
 * Instants before the first segment or far past the last one fall back to `offsetAt`.
 */
export function offsetSweeper(tz: string, segs: readonly OffsetSegment[], to: number): (t: number) => number {
  let i = 0;
  return (t: number): number => {
    if (t < segs[0]!.start || t > to) return offsetAt(tz, t);
    while (i + 1 < segs.length && segs[i + 1]!.start <= t) i++;
    return segs[i]!.offset;
  };
}

/** `YYYY-MM-DD` of a day index (days since 1970-01-01). */
export function isoDateOfDay(day: number): string {
  const d = new Date(day * DAY_MS);
  const y = d.getUTCFullYear();
  const ys = y >= 0 && y <= 9999 ? String(y).padStart(4, '0') : String(y);
  return `${ys}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** Monday-based weekday (Monday = 0 … Sunday = 6) of a day index; 1970-01-01 was a Thursday. */
export const weekdayOfDay = (day: number): number => mod(day + 3, 7);
