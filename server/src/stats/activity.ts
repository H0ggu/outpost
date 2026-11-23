/**
 * Activity (`GET /api/profiles/:slug/activity?tz=`, PLAN §5 "Activity") and the overview's
 * 90-day strip: games and score per local day, hour, weekday and weekday × hour, by when each
 * game ended (`ended_at`; undated PGN games are left out).
 *
 * Local time: SQLite groups games into UTC buckets that never straddle an offset change or a
 * local hour boundary (`bucketSizeFor`: an hour for most zones, 30 / 15 minutes for zones such as
 * Asia/Kolkata or Asia/Kathmandu), then each bucket is shifted by the zone's offset at that
 * instant (tz.ts). So DST, historical offsets and half-hour zones are exact, and the work in
 * JavaScript is per bucket rather than per game.
 *
 * Bounds: one PGN game with a typo'd date (year 1000 or 9999) must not make every request slow
 * and huge, so games dated before 1400 or after tomorrow are left out, offsets are precomputed
 * for at most the 40 years before the last game (older games get exact lookups per instant or per
 * year that has games), and `days` covers at most the last `ACTIVITY_MAX_DAYS`.
 *
 * Date-only games: a PGN or reference game whose headers give a date but no time is stored at
 * 00:00 UTC of that date (chess/pgn.ts). Its calendar date is the one written in the PGN, so it
 * counts on that day and weekday in every zone, and it is left out of `byHour` and `grid`, which
 * would otherwise pile such games into one hour. They are recognised as games from a PGN or the
 * reference DB (opponent kind `pgn` / `fide`) ending exactly at a UTC midnight (`DATE_ONLY_SQL`).
 */
import type { ActivityCell, ActivityDay, ActivityStats } from '@outpost/shared/api';
import { floorToSql, PLAYER_GAMES_BY_PK, scopeWhere, scoreOf, type StatsScope } from './common.ts';
import type { SqlFragment } from './filterSql.ts';
import {
  bucketSizeFor,
  DAY_MS,
  floorDiv,
  HOUR_MS,
  isoDateOfDay,
  mod,
  offsetAt,
  offsetSegments,
  offsetSweeper,
  utcYear,
  weekdayOfDay,
  yearStart,
} from './tz.ts';

/**
 * True (1) for a game of `player_games pg` whose time of day is unknown: from a PGN or the
 * reference DB (online games always carry a time) and stored at exactly 00:00:00.000 UTC.
 */
export const DATE_ONLY_SQL = `(pg.opp_source_kind IN ('pgn', 'fide') AND pg.ended_at % ${DAY_MS} = 0)`;

/** Running counts of one bucket. */
interface Counter {
  games: number;
  w: number;
  d: number;
}

const counter = (): Counter => ({ games: 0, w: 0, d: 0 });
/** A counter as the contract's `ActivityCell`. */
export const toCell = (c: Counter): ActivityCell => ({ games: c.games, score: scoreOf(c.games, c.w, c.d) });

/** Local-time aggregation of a set of games. */
export interface LocalActivity {
  /** Counts per local day index (days since 1970-01-01). */
  days: Map<number, Counter>;
  minDay: number | null;
  maxDay: number | null;
  byHour: Counter[];
  byWeekday: Counter[];
  grid: Counter[][];
}

/**
 * Earliest game date activity considers: the oldest recorded games are from the late 15th
 * century, so anything older is a typo or a placeholder date in a PGN.
 */
export const ACTIVITY_MIN_MS = Date.UTC(1400, 0, 1);
/** Games ending later than this after "now" (a clock-skew margin) are typos and left out too. */
export const ACTIVITY_FUTURE_MARGIN_MS = DAY_MS;
/**
 * Most entries in `ActivityStats.days` (40 years, ending at the last game; `activityDays`).
 * Offsets come from precomputed segments over the same span before the last game; older games
 * (historical PGN collections) cost one `offsetAt` per distinct instant, or their year's segments
 * when that is cheaper, so the work is bounded by the number of games and of years that have
 * games, never by the span between them.
 */
export const ACTIVITY_MAX_DAYS = 14_610;
const SEGMENT_SPAN_MS = ACTIVITY_MAX_DAYS * DAY_MS;
/**
 * Timed games in one UTC year (before the precomputed span) above which that year's offset
 * segments are computed (about 370 `offsetAt` calls, cached per zone and year) instead of one
 * `offsetAt` per game.
 */
const OLD_YEAR_SEGMENTS_FROM = 400;

/**
 * Aggregates the games of `where` (over `player_games pg`) in zone `tz`; `range` optionally bounds
 * `ended_at` (inclusive epoch ms). `tz` must already be valid (`resolveTimeZone`). Games dated
 * before `ACTIVITY_MIN_MS` or more than `ACTIVITY_FUTURE_MARGIN_MS` after `scope.now` are left out.
 */
export function localActivity(
  scope: Pick<StatsScope, 'db' | 'now'>,
  where: SqlFragment,
  tz: string,
  range: { from?: number; to?: number } = {},
): LocalActivity {
  const out: LocalActivity = {
    days: new Map(),
    minDay: null,
    maxDay: null,
    byHour: Array.from({ length: 24 }, counter),
    byWeekday: Array.from({ length: 7 }, counter),
    grid: Array.from({ length: 7 }, () => Array.from({ length: 24 }, counter)),
  };
  const from = Math.max(range.from ?? ACTIVITY_MIN_MS, ACTIVITY_MIN_MS);
  const to = Math.min(range.to ?? Infinity, (scope.now ?? Date.now()) + ACTIVITY_FUTURE_MARGIN_MS);
  if (from > to) return out;
  const cond = `${where.sql} AND pg.ended_at BETWEEN ? AND ?`;
  const params = [...where.params, from, to];

  const span = scope.db.get<{ lo: number | null; hi: number | null }>(
    `SELECT MIN(pg.ended_at) AS lo, MAX(pg.ended_at) AS hi FROM ${PLAYER_GAMES_BY_PK} WHERE ${cond}`,
    params,
  );
  if (!span || span.lo === null || span.hi === null) return out;

  const add = (day: number, hour: number | null, r: Counter): void => {
    const weekday = weekdayOfDay(day);
    let c = out.days.get(day);
    if (!c) {
      c = counter();
      out.days.set(day, c);
    }
    const targets = hour === null ? [c, out.byWeekday[weekday]!] : [c, out.byHour[hour]!, out.byWeekday[weekday]!, out.grid[weekday]![hour]!];
    for (const target of targets) {
      target.games += r.games;
      target.w += r.w;
      target.d += r.d;
    }
    if (out.minDay === null || day < out.minDay) out.minDay = day;
    if (out.maxDay === null || day > out.maxDay) out.maxDay = day;
  };
  /** Adds the games of UTC instant `t` (a bucket start or a game end) whose zone offset is `offset`. */
  const addAt = (t: number, offset: number, dateOnly: number, r: Counter): void => {
    // A date-only game sits at a UTC midnight, which every bucket width divides: `t` is that midnight.
    if (dateOnly) return add(floorDiv(t, DAY_MS), null, r);
    const local = t + offset;
    add(floorDiv(local, DAY_MS), Math.floor(mod(local, DAY_MS) / HOUR_MS), r);
  };

  // Recent games (the last SEGMENT_SPAN_MS before the last one): bucketed in SQL.
  const segFrom = Math.max(span.lo, span.hi - SEGMENT_SPAN_MS);
  const segs = offsetSegments(tz, segFrom, span.hi);
  const width = bucketSizeFor(segs);
  const bucket = floorToSql('pg.ended_at', width);
  const rows = scope.db.all<{ b: number; dateOnly: number } & Counter>(
    `SELECT ${bucket.sql} AS b, ${DATE_ONLY_SQL} AS dateOnly, COUNT(*) AS games, SUM(pg.outcome = 'w') AS w,
            SUM(pg.outcome = 'd') AS d
       FROM ${PLAYER_GAMES_BY_PK} WHERE ${cond} AND pg.ended_at >= ?
      GROUP BY 1, 2 ORDER BY 1, 2`,
    [...bucket.params, ...params, segFrom],
  );
  const offsetOf = offsetSweeper(tz, segs, span.hi);
  // The first bucket may start before `segFrom`: take the offset where its games are.
  for (const r of rows) addAt(r.b, r.dateOnly ? 0 : offsetOf(Math.max(r.b, segFrom)), r.dateOnly, r);

  // Older games: exact offsets per distinct end instant, one UTC year at a time. A year with many
  // timed games takes its (cached) offset segments; a sparse one an `offsetAt` per instant.
  if (span.lo < segFrom) {
    const old = scope.db.all<{ t: number; dateOnly: number } & Counter>(
      `SELECT pg.ended_at AS t, ${DATE_ONLY_SQL} AS dateOnly, COUNT(*) AS games, SUM(pg.outcome = 'w') AS w,
              SUM(pg.outcome = 'd') AS d
         FROM ${PLAYER_GAMES_BY_PK} WHERE ${cond} AND pg.ended_at < ?
        GROUP BY 1, 2 ORDER BY 1, 2`,
      [...params, segFrom],
    );
    for (let i = 0; i < old.length; ) {
      const year = utcYear(old[i]!.t);
      let end = i;
      let timed = 0;
      for (; end < old.length && utcYear(old[end]!.t) === year; end++) if (!old[end]!.dateOnly) timed++;
      const last = Math.min(yearStart(year + 1) - 1, segFrom);
      const offsetOf = timed > OLD_YEAR_SEGMENTS_FROM ? offsetSweeper(tz, offsetSegments(tz, old[i]!.t, last), last) : (t: number) => offsetAt(tz, t);
      for (; i < end; i++) {
        const r = old[i]!;
        addAt(r.t, r.dateOnly ? 0 : offsetOf(r.t), r.dateOnly, r);
      }
    }
  }
  return out;
}

/** One `ActivityDay` per day from `first` to `last` (day indexes), zeros included. */
export function dayRange(days: Map<number, Counter>, first: number, last: number): ActivityDay[] {
  const out: ActivityDay[] = [];
  for (let d = first; d <= last; d++) {
    const c = days.get(d);
    out.push({ date: isoDateOfDay(d), games: c?.games ?? 0, score: c ? scoreOf(c.games, c.w, c.d) : null });
  }
  return out;
}

/**
 * The days of `ActivityStats.days`: from the first to the last day with games, or, when that is
 * more than `ACTIVITY_MAX_DAYS`, from the first day with games among the last `ACTIVITY_MAX_DAYS`.
 */
export function activityDays(a: LocalActivity): ActivityDay[] {
  if (a.minDay === null || a.maxDay === null) return [];
  let first = a.minDay;
  if (a.maxDay - first >= ACTIVITY_MAX_DAYS) {
    first = a.maxDay;
    for (const day of a.days.keys()) if (day < first && a.maxDay - day < ACTIVITY_MAX_DAYS) first = day;
  }
  return dayRange(a.days, first, a.maxDay);
}

/** Activity stats of a scope in zone `tz` (already validated). */
export function activityStats(scope: StatsScope, tz: string): ActivityStats {
  const a = localActivity(scope, scopeWhere(scope), tz);
  return {
    tz,
    days: activityDays(a),
    byHour: a.byHour.map(toCell),
    byWeekday: a.byWeekday.map(toCell),
    grid: a.grid.map(row => row.map(toCell)),
  };
}

/** The last `n` days (today in `tz` included), oldest first, zeros included. */
export function recentDays(scope: StatsScope, n: number, tz = 'UTC'): ActivityDay[] {
  const now = scope.now ?? Date.now();
  const today = floorDiv(now + offsetSegments(tz, now, now)[0]!.offset, DAY_MS);
  const first = today - (n - 1);
  // Bound the query generously (±1 day for the zone offset); days outside are dropped below.
  const a = localActivity(scope, scopeWhere(scope), tz, { from: first * DAY_MS - DAY_MS, to: now });
  return dayRange(a.days, first, today);
}
