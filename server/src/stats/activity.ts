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
  offsetSegments,
  offsetSweeper,
  weekdayOfDay,
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
const toCell = (c: Counter): ActivityCell => ({ games: c.games, score: scoreOf(c.games, c.w, c.d) });

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
 * Aggregates the games of `where` (over `player_games pg`) in zone `tz`; `range` optionally bounds
 * `ended_at` (inclusive epoch ms). `tz` must already be valid (`resolveTimeZone`).
 */
export function localActivity(
  scope: Pick<StatsScope, 'db'>,
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
  let cond = `${where.sql} AND pg.ended_at IS NOT NULL`;
  const params = [...where.params];
  if (range.from !== undefined) {
    cond += ' AND pg.ended_at >= ?';
    params.push(range.from);
  }
  if (range.to !== undefined) {
    cond += ' AND pg.ended_at <= ?';
    params.push(range.to);
  }

  const span = scope.db.get<{ lo: number | null; hi: number | null }>(
    `SELECT MIN(pg.ended_at) AS lo, MAX(pg.ended_at) AS hi FROM ${PLAYER_GAMES_BY_PK} WHERE ${cond}`,
    params,
  );
  if (!span || span.lo === null || span.hi === null) return out;

  const segs = offsetSegments(tz, span.lo, span.hi);
  const width = bucketSizeFor(segs);
  const bucket = floorToSql('pg.ended_at', width);
  // A date-only game sits at a UTC midnight, which every bucket width divides: its bucket `b` is
  // that midnight.
  const rows = scope.db.all<{ b: number; dateOnly: number; games: number; w: number; d: number }>(
    `SELECT ${bucket.sql} AS b, ${DATE_ONLY_SQL} AS dateOnly, COUNT(*) AS games, SUM(pg.outcome = 'w') AS w,
            SUM(pg.outcome = 'd') AS d
       FROM ${PLAYER_GAMES_BY_PK} WHERE ${cond}
      GROUP BY 1, 2 ORDER BY 1, 2`,
    [...bucket.params, ...params],
  );

  const offsetOf = offsetSweeper(tz, segs, span.hi);
  for (const r of rows) {
    let day: number;
    let hour: number | null = null;
    if (r.dateOnly) day = floorDiv(r.b, DAY_MS);
    else {
      // The first bucket may start before the first game: take the offset where its games are.
      const local = r.b + offsetOf(Math.max(r.b, span.lo));
      day = floorDiv(local, DAY_MS);
      hour = Math.floor(mod(local, DAY_MS) / HOUR_MS);
    }
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

/** Activity stats of a scope in zone `tz` (already validated). */
export function activityStats(scope: StatsScope, tz: string): ActivityStats {
  const a = localActivity(scope, scopeWhere(scope), tz);
  return {
    tz,
    days: a.minDay !== null && a.maxDay !== null ? dayRange(a.days, a.minDay, a.maxDay) : [],
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
