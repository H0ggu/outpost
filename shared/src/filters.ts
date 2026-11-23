/**
 * The common profile filter (PLAN §6 "Common filter query"): one schema used by every stats
 * endpoint, the player explorer and the web filters bar. State lives in the URL query.
 *
 * - `parseFilters` reads a query (URLSearchParams, Fastify's `req.query`, or a plain record).
 * - `filtersToQuery` writes the canonical query (stable key order, sorted sets) — use
 *   `filtersKey` for cache keys.
 * - `encodeFiltersSegment` / `decodeFiltersSegment` carry filters in the explorer path segment
 *   `/api/explorer/f/<segment>/player`, because lila builds `new URL('./player', endpoint)` and
 *   would drop a query string.
 * - `resolveDateRange` turns `period` presets or `from`/`to` into epoch-ms bounds.
 */
import { z } from 'zod';
import { SLUG_RE } from './api.ts';
import { OUTCOMES, TIME_CLASSES, UCI_RE, type Color, type Outcome, type TimeClass } from './chess.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Date presets. `3m`/`6m`/`12m` are calendar months back from now. */
export const PERIODS = ['24h', '7d', '30d', '3m', '6m', '12m'] as const;
/** Date preset. */
export type Period = (typeof PERIODS)[number];

/**
 * Opponent strength relative to the player's own pre-game rating (diff = opponent − player):
 * `-200` diff ≤ −200, `-100` diff ≤ −100, `eq` |diff| ≤ 100, `100` diff ≥ 100, `200` diff ≥ 200.
 */
export const OPP_STRENGTHS = ['-200', '-100', 'eq', '100', '200'] as const;
/** Relative opponent strength bucket. */
export type OppStrength = (typeof OPP_STRENGTHS)[number];

/** Rated filter. */
export const RATED_FILTERS = ['rated', 'unrated'] as const;
/** Rated filter value. */
export type RatedFilter = (typeof RATED_FILTERS)[number];

/** Maximum plies in a `line` filter (positions are indexed for the first 50 plies, PLAN §4). */
export const MAX_LINE_PLIES = 50;

/** Every filter is optional; absent means "no restriction". */
export interface ProfileFilters {
  /** The profile player's colour. */
  color?: Color;
  /** Date preset; when set, `from`/`to` are ignored. */
  period?: Period;
  /** First day (UTC), inclusive. */
  from?: string;
  /** Last day (UTC), inclusive. */
  to?: string;
  /** Time classes (any of). */
  tc?: TimeClass[];
  /** Source ids (any of) — only sources of the profile being viewed count. */
  src?: number[];
  rated?: RatedFilter;
  /** Outcomes from the player's side (any of). */
  outcome?: Outcome[];
  opp?: OppStrength;
  /** Opponent name or username, case-insensitive substring. */
  oppName?: string;
  /** Event / tournament name, case-insensitive substring. */
  event?: string;
  /** UCI moves from the start position; only games that reached the position after this line. */
  line?: string[];
}

/** Query keys of `ProfileFilters`, in canonical order. */
export const FILTER_KEYS = [
  'color',
  'period',
  'from',
  'to',
  'tc',
  'src',
  'rated',
  'outcome',
  'opp',
  'oppName',
  'event',
  'line',
] as const satisfies ReadonlyArray<keyof ProfileFilters>;

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const isValidIsoDate = (s: string): boolean => {
  if (!ISO_DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};

const isoDate = z.string().refine(isValidIsoDate, { message: 'expected a valid YYYY-MM-DD date' });

/** A comma-separated list whose items each match `item`. Duplicates are removed. */
const csvOf = <T extends z.ZodType<unknown, string>>(item: T, max: number) =>
  z
    .string()
    .transform(s => [...new Set(s.split(',').map(x => x.trim()).filter(x => x !== ''))])
    .pipe(z.array(item).min(1).max(max));

/** A comma-separated list where order and repeats matter (the `line` filter). */
const uciLine = z
  .string()
  .transform(s => s.split(',').map(x => x.trim()).filter(x => x !== ''))
  .pipe(z.array(z.string().regex(UCI_RE, { message: 'expected UCI moves' })).min(1).max(MAX_LINE_PLIES));

/** Per-key schemas over raw query strings. */
export const filterFieldSchemas = {
  color: z.enum(['white', 'black']),
  period: z.enum(PERIODS),
  from: isoDate,
  to: isoDate,
  tc: csvOf(z.enum(TIME_CLASSES), TIME_CLASSES.length),
  src: csvOf(z.string().regex(/^[1-9]\d{0,15}$/).transform(Number), 100),
  rated: z.enum(RATED_FILTERS),
  outcome: csvOf(z.enum(OUTCOMES), OUTCOMES.length),
  opp: z.enum(OPP_STRENGTHS),
  oppName: z.string().trim().min(1).max(100),
  event: z.string().trim().min(1).max(200),
  line: uciLine,
} as const;

/** Zod schema of the raw filter query (strings in, `ProfileFilters` out). Unknown keys are stripped. */
export const profileFiltersSchema = z
  .object({
    color: filterFieldSchemas.color.optional(),
    period: filterFieldSchemas.period.optional(),
    from: filterFieldSchemas.from.optional(),
    to: filterFieldSchemas.to.optional(),
    tc: filterFieldSchemas.tc.optional(),
    src: filterFieldSchemas.src.optional(),
    rated: filterFieldSchemas.rated.optional(),
    outcome: filterFieldSchemas.outcome.optional(),
    opp: filterFieldSchemas.opp.optional(),
    oppName: filterFieldSchemas.oppName.optional(),
    event: filterFieldSchemas.event.optional(),
    line: filterFieldSchemas.line.optional(),
  })
  .refine(f => !(f.from && f.to && f.from > f.to), { message: '`from` must not be after `to`', path: ['from'] });

// ---------------------------------------------------------------------------
// Parsing and serialisation
// ---------------------------------------------------------------------------

/** Anything a query can arrive as. Repeated keys (arrays) are joined with commas. */
export type QueryInput =
  | URLSearchParams
  | Record<string, string | number | boolean | readonly string[] | null | undefined>;

/** Flattens a query into `{key: string}` for the filter keys, dropping empty values. */
const rawFilterRecord = (input: QueryInput): Partial<Record<(typeof FILTER_KEYS)[number], string>> => {
  const out: Partial<Record<(typeof FILTER_KEYS)[number], string>> = {};
  for (const key of FILTER_KEYS) {
    let v: string | undefined;
    if (input instanceof URLSearchParams) {
      const all = input.getAll(key);
      v = all.length ? all.join(',') : undefined;
    } else {
      const raw = input[key];
      if (raw === null || raw === undefined) v = undefined;
      else if (Array.isArray(raw)) v = raw.join(',');
      else v = String(raw);
    }
    if (v !== undefined && v.trim() !== '') out[key] = v;
  }
  return out;
};

/**
 * Parses filters from a query.
 * - `strict` (server): throws a `ZodError` on any invalid value → answer 400 `validation`.
 * - `lenient` (web, reading the address bar): drops invalid values and keeps the rest.
 */
export const parseFilters = (input: QueryInput, mode: 'strict' | 'lenient' = 'strict'): ProfileFilters => {
  const raw = rawFilterRecord(input);
  if (mode === 'strict') return normalizeFilters(profileFiltersSchema.parse(raw));
  const out: ProfileFilters = {};
  for (const key of FILTER_KEYS) {
    const v = raw[key];
    if (v === undefined) continue;
    const r = filterFieldSchemas[key].safeParse(v);
    if (r.success) (out as Record<string, unknown>)[key] = r.data;
  }
  if (out.from && out.to && out.from > out.to) delete out.to;
  return normalizeFilters(out);
};

const byOrder =
  <T extends string>(order: readonly T[]) =>
  (a: T, b: T): number =>
    order.indexOf(a) - order.indexOf(b);

/** Canonical form: empty values removed, sets sorted and de-duplicated, `line` kept in order. */
export const normalizeFilters = (f: ProfileFilters): ProfileFilters => {
  const out: ProfileFilters = {};
  if (f.color) out.color = f.color;
  if (f.period) out.period = f.period;
  else {
    if (f.from) out.from = f.from;
    if (f.to) out.to = f.to;
  }
  if (f.tc?.length) out.tc = [...new Set(f.tc)].sort(byOrder(TIME_CLASSES));
  if (f.src?.length) out.src = [...new Set(f.src)].sort((a, b) => a - b);
  if (f.rated) out.rated = f.rated;
  if (f.outcome?.length) out.outcome = [...new Set(f.outcome)].sort(byOrder(OUTCOMES));
  if (f.opp) out.opp = f.opp;
  if (f.oppName?.trim()) out.oppName = f.oppName.trim();
  if (f.event?.trim()) out.event = f.event.trim();
  if (f.line?.length) out.line = [...f.line];
  return out;
};

/** Canonical query string parameters for filters (stable order; arrays as csv). */
export const filtersToQuery = (f: ProfileFilters): URLSearchParams => {
  const n = normalizeFilters(f);
  const q = new URLSearchParams();
  for (const key of FILTER_KEYS) {
    const v = n[key];
    if (v === undefined) continue;
    q.set(key, Array.isArray(v) ? v.join(',') : String(v));
  }
  return q;
};

/** Stable string for cache keys (TanStack Query keys, server caches). `''` when unfiltered. */
export const filtersKey = (f: ProfileFilters): string => filtersToQuery(f).toString();

/** True when no filter is set. */
export const isEmptyFilters = (f: ProfileFilters): boolean => filtersKey(f) === '';

// ---------------------------------------------------------------------------
// Date ranges and opponent strength
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

const monthsBack = (now: number, months: number): number => {
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.getTime();
};

/**
 * Epoch-ms bounds (inclusive) for the date filters. `period` wins over `from`/`to`; custom
 * dates are UTC days (`to` includes the whole day). Null means unbounded.
 */
export const resolveDateRange = (
  f: ProfileFilters,
  now: number = Date.now(),
): { from: number | null; to: number | null } => {
  switch (f.period) {
    case '24h':
      return { from: now - DAY_MS, to: now };
    case '7d':
      return { from: now - 7 * DAY_MS, to: now };
    case '30d':
      return { from: now - 30 * DAY_MS, to: now };
    case '3m':
      return { from: monthsBack(now, 3), to: now };
    case '6m':
      return { from: monthsBack(now, 6), to: now };
    case '12m':
      return { from: monthsBack(now, 12), to: now };
    default:
      break;
  }
  const day = (s: string): number => {
    const [y, m, d] = s.split('-').map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, d);
  };
  return {
    from: f.from ? day(f.from) : null,
    to: f.to ? day(f.to) + DAY_MS - 1 : null,
  };
};

/** Allowed (opponent − player) rating difference for an `opp` bucket; null bounds are open. */
export const oppStrengthRange = (opp: OppStrength): { minDiff: number | null; maxDiff: number | null } => {
  switch (opp) {
    case '-200':
      return { minDiff: null, maxDiff: -200 };
    case '-100':
      return { minDiff: null, maxDiff: -100 };
    case 'eq':
      return { minDiff: -100, maxDiff: 100 };
    case '100':
      return { minDiff: 100, maxDiff: null };
    case '200':
      return { minDiff: 200, maxDiff: null };
  }
};

// ---------------------------------------------------------------------------
// base64url and the explorer path segment
// ---------------------------------------------------------------------------

/** UTF-8 → base64url without padding. */
export const base64UrlEncode = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/** base64url (padding optional) → UTF-8. Throws on malformed input. */
export const base64UrlDecode = (encoded: string): string => {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(encoded)) throw new Error('invalid base64url');
  const unpadded = encoded.replace(/=+$/, '');
  if (unpadded.length % 4 === 1) throw new Error('invalid base64url length');
  const b64 = unpadded.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (unpadded.length % 4)) % 4);
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
};

/** Path segment meaning "no filters" (never a valid base64url payload on its own). */
export const EMPTY_FILTERS_SEGMENT = '_';
/** Longest accepted segment, to bound decoding work. */
export const MAX_FILTERS_SEGMENT_LENGTH = 4096;

/** Filters → explorer path segment: base64url of the canonical query, or `_` when empty. */
export const encodeFiltersSegment = (f: ProfileFilters): string => {
  const q = filtersKey(f);
  return q === '' ? EMPTY_FILTERS_SEGMENT : base64UrlEncode(q);
};

/** Explorer path segment → filters. Throws (strict) on malformed segments or invalid filters. */
export const decodeFiltersSegment = (segment: string, mode: 'strict' | 'lenient' = 'strict'): ProfileFilters => {
  if (segment === '' || segment === EMPTY_FILTERS_SEGMENT) return {};
  if (segment.length > MAX_FILTERS_SEGMENT_LENGTH) throw new Error('filters segment too long');
  let query: string;
  try {
    query = base64UrlDecode(segment);
  } catch (e) {
    if (mode === 'lenient') return {};
    throw e;
  }
  return parseFilters(new URLSearchParams(query), mode);
};

// ---------------------------------------------------------------------------
// Player specs (explorer `player=` parameter, PLAN §6)
// ---------------------------------------------------------------------------

/** Parsed `player` parameter of the explorer endpoints. */
export type PlayerSpec =
  | { kind: 'profile'; slug: string }
  | { kind: 'lichess'; username: string }
  | { kind: 'chesscom'; username: string }
  | { kind: 'db'; databaseId: number }
  | { kind: 'ref'; fideId: string };

const USERNAME_RE = /^[A-Za-z0-9_-]{1,50}$/;

/**
 * Parses `slug`, `lichess:<user>`, `chesscom:<user>`, `db:<id>` or `ref:<fideId>`; null if invalid.
 * A bare spec must be a valid profile slug (`SLUG_RE`, the same rule as everywhere else).
 */
export const parsePlayerSpec = (spec: string): PlayerSpec | null => {
  const i = spec.indexOf(':');
  if (i < 0) return SLUG_RE.test(spec) ? { kind: 'profile', slug: spec } : null;
  const prefix = spec.slice(0, i);
  const rest = spec.slice(i + 1);
  switch (prefix) {
    case 'lichess':
    case 'chesscom':
      return USERNAME_RE.test(rest) ? { kind: prefix, username: rest.toLowerCase() } : null;
    case 'db':
      return /^[1-9]\d{0,15}$/.test(rest) ? { kind: 'db', databaseId: Number(rest) } : null;
    case 'ref':
      return /^\d{1,12}$/.test(rest) ? { kind: 'ref', fideId: rest } : null;
    default:
      return null;
  }
};

/** Inverse of `parsePlayerSpec`. */
export const formatPlayerSpec = (p: PlayerSpec): string => {
  switch (p.kind) {
    case 'profile':
      return p.slug;
    case 'lichess':
    case 'chesscom':
      return `${p.kind}:${p.username}`;
    case 'db':
      return `db:${p.databaseId}`;
    case 'ref':
      return `ref:${p.fideId}`;
  }
};

// ---------------------------------------------------------------------------
// Generic query helpers
// ---------------------------------------------------------------------------

/** Values accepted by `toSearchParams`. Arrays become csv; null/undefined/'' are dropped. */
export type QueryValue = string | number | boolean | null | undefined | ReadonlyArray<string | number>;

/** Builds URLSearchParams from a flat record (filters + extra params like `page`). */
export const toSearchParams = (params: Record<string, QueryValue>): URLSearchParams => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '') continue;
    if (Array.isArray(v)) {
      if (v.length) q.set(k, v.join(','));
    } else q.set(k, String(v));
  }
  return q;
};

/** `path` plus `?query` when there is any. */
export const withQuery = (path: string, params?: URLSearchParams | Record<string, QueryValue>): string => {
  if (!params) return path;
  const q = (params instanceof URLSearchParams ? params : toSearchParams(params)).toString();
  return q ? `${path}${path.includes('?') ? '&' : '?'}${q}` : path;
};

/**
 * Filters plus endpoint params as one query (`filtersToQuery` first, then extras). Endpoint params
 * must not reuse a filter key (the server would read them as filters): that throws.
 */
export const statsQuery = (f: ProfileFilters, extra: Record<string, QueryValue> = {}): URLSearchParams => {
  const q = filtersToQuery(f);
  for (const [k, v] of toSearchParams(extra)) {
    if ((FILTER_KEYS as readonly string[]).includes(k)) throw new Error(`statsQuery: "${k}" is a filter key; set it in the filters`);
    q.set(k, v);
  }
  return q;
};
