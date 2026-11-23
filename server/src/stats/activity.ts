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
 */
import type { ActivityCell, ActivityDay, ActivityStats } from '@outpost/shared/api';
import { floorToSql, scopeWhere, scoreOf, type StatsScope } from './common.ts';
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
    `SELECT MIN(pg.ended_at) AS lo, MAX(pg.ended_at) AS hi FROM player_games pg WHERE ${cond}`,
    params,
  );
  if (!span || span.lo === null || span.hi === null) return out;

  const segs = offsetSegments(tz, span.lo, span.hi);
  const width = bucketSizeFor(segs);
  const bucket = floorToSql('pg.ended_at', width);
  const rows = scope.db.all<{ b: number; games: number; w: number; d: number }>(
    `SELECT ${bucket.sql} AS b, COUNT(*) AS games, SUM(pg.outcome = 'w') AS w, SUM(pg.outcome = 'd') AS d
       FROM player_games pg WHERE ${cond}
      GROUP BY 1 ORDER BY 1`,
    [...bucket.params, ...params],
  );

  const offsetOf = offsetSweeper(tz, segs, span.hi);
  for (const r of rows) {
    // The first bucket may start before the first game: take the offset where its games are.
    const local = r.b + offsetOf(Math.max(r.b, span.lo));
    const day = floorDiv(local, DAY_MS);
    const hour = Math.floor(mod(local, DAY_MS) / HOUR_MS);
    const weekday = weekdayOfDay(day);
    let c = out.days.get(day);
    if (!c) {
      c = counter();
      out.days.set(day, c);
    }
    for (const target of [c, out.byHour[hour]!, out.byWeekday[weekday]!, out.grid[weekday]![hour]!]) {
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
