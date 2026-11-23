/**
 * Rating history (`GET /api/profiles/:slug/rating`, PLAN §5 "Rating") and the overview sparkline.
 *
 * Series: one per (source, time class), from the rated games in `player_games`. A point is the
 * rating after the last game of each UTC day (`rating_after`, else the pre-game rating for
 * sources that only know that, such as PGN Elo tags). Long histories are reduced with
 * largest-triangle-three-buckets, which keeps peaks and dips, to at most `maxPoints` per series.
 *
 * Averages: over the last n games (by end time) for n in `RATING_AVERAGE_SIZES` smaller than the
 * number of games, plus all games (`n: null`): the player's and the opponents' mean pre-game
 * rating and the score.
 */
import type { EpochMs, Id, RatingAverage, RatingSeries, RatingStats, TimeClass } from '@outpost/shared/api';
import { TIME_CLASSES } from '@outpost/shared/chess';
import { floorToSql, scopeWhere, scoreOf, type StatsScope } from './common.ts';
import { DAY_MS } from './tz.ts';

/** Most points per series on the rating tab and in the overview sparkline. */
export const RATING_MAX_POINTS = 500;
export const SPARKLINE_MAX_POINTS = 120;
/** "Last n games" windows of the averages table (ChessMonitor's list). */
export const RATING_AVERAGE_SIZES = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10_000, 20_000, 50_000] as const;

type Point = [EpochMs, number];

/**
 * Largest-triangle-three-buckets downsampling (Steinarsson 2013): keeps the first and last point
 * and, per bucket, the point forming the largest triangle with its neighbours.
 */
export function lttb(points: readonly Point[], threshold: number): Point[] {
  const n = points.length;
  if (threshold >= n || threshold < 3) return [...points];
  const out: Point[] = [points[0]!];
  const every = (n - 2) / (threshold - 2);
  let a = 0;
  for (let i = 0; i < threshold - 2; i++) {
    const avgStart = Math.floor((i + 1) * every) + 1;
    const avgEnd = Math.min(Math.floor((i + 2) * every) + 1, n);
    let avgX = 0;
    let avgY = 0;
    for (let j = avgStart; j < avgEnd; j++) {
      avgX += points[j]![0];
      avgY += points[j]![1];
    }
    const len = Math.max(avgEnd - avgStart, 1);
    avgX /= len;
    avgY /= len;
    const rangeStart = Math.floor(i * every) + 1;
    const rangeEnd = Math.floor((i + 1) * every) + 1;
    const [ax, ay] = points[a]!;
    let maxArea = -1;
    let next = rangeStart;
    for (let j = rangeStart; j < rangeEnd; j++) {
      const [px, py] = points[j]!;
      const area = Math.abs((ax - avgX) * (py - ay) - (ax - px) * (avgY - ay));
      if (area > maxArea) {
        maxArea = area;
        next = j;
      }
    }
    out.push(points[next]!);
    a = next;
  }
  out.push(points[n - 1]!);
  return out;
}

/** Rating series of a scope; `since` limits to games ending at or after it. */
export function ratingSeries(scope: StatsScope, opts: { since?: EpochMs; maxPoints?: number } = {}): RatingSeries[] {
  const where = scopeWhere(scope);
  const day = floorToSql('pg.ended_at', DAY_MS);
  const sinceSql = opts.since !== undefined ? ' AND pg.ended_at >= ?' : '';
  const rows = scope.db.all<{ source_id: Id; time_class: TimeClass; t: number; r: number }>(
    `SELECT pg.source_id AS source_id, pg.time_class AS time_class, ${day.sql} AS day,
            MAX(pg.ended_at) AS t, COALESCE(pg.rating_after, pg.rating) AS r
       FROM player_games pg
      WHERE ${where.sql} AND pg.rated = 1 AND pg.ended_at IS NOT NULL
        AND COALESCE(pg.rating_after, pg.rating) IS NOT NULL${sinceSql}
      GROUP BY 1, 2, 3
      ORDER BY 1, 2, 3`,
    [...day.params, ...where.params, ...(opts.since !== undefined ? [opts.since] : [])],
  );
  const series = new Map<string, RatingSeries>();
  for (const r of rows) {
    const key = `${r.source_id}:${r.time_class}`;
    let s = series.get(key);
    if (!s) {
      s = { sourceId: r.source_id, timeClass: r.time_class, points: [] };
      series.set(key, s);
    }
    s.points.push([r.t, r.r]);
  }
  const max = opts.maxPoints ?? RATING_MAX_POINTS;
  return [...series.values()]
    .map(s => ({ ...s, points: lttb(s.points, max) }))
    .sort((a, b) => a.sourceId - b.sourceId || TIME_CLASSES.indexOf(a.timeClass) - TIME_CLASSES.indexOf(b.timeClass));
}

interface AverageBucket {
  b: number;
  games: number;
  sr: number | null;
  cr: number;
  so: number | null;
  co: number;
  w: number;
  d: number;
}

/** Rating averages of a scope (see the module comment). */
export function ratingAverages(scope: StatsScope): RatingAverage[] {
  const where = scopeWhere(scope);
  // Rank games newest first (undated last), then sum per window: bucket i holds the games ranked
  // in (size[i-1], size[i]]; prefix sums give each "last n" window in one pass.
  const cases = RATING_AVERAGE_SIZES.map((n, i) => `WHEN rn <= ${n} THEN ${i}`).join(' ');
  const rows = scope.db.all<AverageBucket>(
    `WITH f AS (
        SELECT pg.rating, pg.opp_rating, pg.outcome,
               ROW_NUMBER() OVER (ORDER BY pg.ended_at DESC, pg.game_id DESC, pg.source_id) AS rn
          FROM player_games pg WHERE ${where.sql})
      SELECT CASE ${cases} ELSE ${RATING_AVERAGE_SIZES.length} END AS b, COUNT(*) AS games,
             SUM(rating) AS sr, COUNT(rating) AS cr, SUM(opp_rating) AS so, COUNT(opp_rating) AS co,
             SUM(outcome = 'w') AS w, SUM(outcome = 'd') AS d
        FROM f GROUP BY 1 ORDER BY 1`,
    where.params,
  );
  const acc = { games: 0, sr: 0, cr: 0, so: 0, co: 0, w: 0, d: 0 };
  const average = (n: number | null): RatingAverage => ({
    n,
    games: acc.games,
    avgRating: acc.cr > 0 ? Math.round(acc.sr / acc.cr) : null,
    avgOppRating: acc.co > 0 ? Math.round(acc.so / acc.co) : null,
    score: scoreOf(acc.games, acc.w, acc.d),
  });
  const total = rows.reduce((s, r) => s + r.games, 0);
  const out: RatingAverage[] = [];
  let next = 0;
  const takeThrough = (bucket: number): void => {
    while (next < rows.length && rows[next]!.b <= bucket) {
      const r = rows[next++]!;
      acc.games += r.games;
      acc.sr += r.sr ?? 0;
      acc.cr += r.cr;
      acc.so += r.so ?? 0;
      acc.co += r.co;
      acc.w += r.w;
      acc.d += r.d;
    }
  };
  for (const [i, n] of RATING_AVERAGE_SIZES.entries()) {
    if (n >= total) break;
    takeThrough(i);
    out.push(average(n));
  }
  takeThrough(RATING_AVERAGE_SIZES.length);
  out.push(average(null));
  return out;
}

/** The rating tab. */
export const ratingStats = (scope: StatsScope): RatingStats => ({ series: ratingSeries(scope), averages: ratingAverages(scope) });
