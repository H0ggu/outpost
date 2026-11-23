/**
 * Overview tab (`GET /api/profiles/:slug/overview`, PLAN §5 "Overview"); every part honours the
 * filters.
 *
 * - `totals`, `timeClasses`, `byColor`, `terminations`: one pass (outcome × termination × time
 *   class × colour, behaviour.ts).
 * - `timeClasses[].ratings`: per source, the rating after its latest rated game in that class.
 * - `topOpenings`: the 5 most played openings per colour (openings.ts).
 * - `latestGames`: the 5 newest games.
 * - `activity`: the last 90 UTC days, zeros included; `ratingSparkline`: the last 365 days.
 */
import type { Id, OverviewStats, OverviewTimeClassRow, TerminationRow, TimeClass } from '@outpost/shared/api';
import { emptyWdl, TERMINATIONS, TIME_CLASSES } from '@outpost/shared/chess';
import type { OpeningBook } from '../chess/openings.ts';
import { recentDays } from './activity.ts';
import { outcomeBreakdown } from './behaviour.ts';
import { PLAYER_GAMES_BY_PK, scopeWhere, type StatsScope } from './common.ts';
import { latestGames } from './games.ts';
import { openingsStats } from './openings.ts';
import { ratingSeries, SPARKLINE_MAX_POINTS } from './rating.ts';
import { DAY_MS } from './tz.ts';

/** Days in the overview activity strip and rating sparkline. */
export const OVERVIEW_ACTIVITY_DAYS = 90;
export const OVERVIEW_SPARKLINE_DAYS = 365;
/** Rows in the overview's opening lists and latest games. */
export const OVERVIEW_TOP_OPENINGS = 5;
export const OVERVIEW_LATEST_GAMES = 5;

/** Per source and time class, the rating after the latest rated game of the scope (in the class's own rating pool). */
export function currentRatings(scope: StatsScope): Array<{ sourceId: Id; timeClass: TimeClass; rating: number }> {
  const where = scopeWhere(scope);
  return scope.db
    .all<{ source_id: Id; time_class: TimeClass; t: number | null; r: number }>(
      `SELECT pg.source_id AS source_id, pg.time_class AS time_class, MAX(pg.ended_at) AS t,
              COALESCE(pg.rating_after, pg.rating) AS r
         FROM ${PLAYER_GAMES_BY_PK}
        WHERE ${where.sql} AND pg.rated = 1 AND pg.rating_pool IS NULL AND COALESCE(pg.rating_after, pg.rating) IS NOT NULL
        GROUP BY 1, 2
        ORDER BY 1`,
      where.params,
    )
    .map(r => ({ sourceId: r.source_id, timeClass: r.time_class, rating: r.r }));
}

/** The overview of a scope. */
export function overviewStats(scope: StatsScope, book?: OpeningBook): OverviewStats {
  const now = scope.now ?? Date.now();
  const at = { ...scope, now };
  const cells = outcomeBreakdown(at);

  const totals = { ...emptyWdl(), games: 0 };
  const byColor = { white: { ...emptyWdl(), games: 0 }, black: { ...emptyWdl(), games: 0 } };
  const byClass = new Map<TimeClass, OverviewTimeClassRow>();
  const byTerm = new Map<string, TerminationRow>();
  for (const c of cells) {
    totals[c.outcome] += c.games;
    totals.games += c.games;
    byColor[c.color][c.outcome] += c.games;
    byColor[c.color].games += c.games;
    let tc = byClass.get(c.timeClass);
    if (!tc) {
      tc = { timeClass: c.timeClass, games: 0, ...emptyWdl(), ratings: [] };
      byClass.set(c.timeClass, tc);
    }
    tc[c.outcome] += c.games;
    tc.games += c.games;
    let term = byTerm.get(c.termination);
    if (!term) {
      term = { termination: c.termination, ...emptyWdl() };
      byTerm.set(c.termination, term);
    }
    term[c.outcome] += c.games;
  }
  for (const r of currentRatings(at)) byClass.get(r.timeClass)?.ratings.push({ sourceId: r.sourceId, rating: r.rating });

  const openings = openingsStats(at, { side: 'both', order: 'most', limit: OVERVIEW_TOP_OPENINGS }, book);
  const termTotal = (t: TerminationRow): number => t.w + t.d + t.l;

  return {
    totals,
    timeClasses: [...byClass.values()].sort((a, b) => TIME_CLASSES.indexOf(a.timeClass) - TIME_CLASSES.indexOf(b.timeClass)),
    byColor,
    terminations: [...byTerm.values()].sort(
      (a, b) => termTotal(b) - termTotal(a) || TERMINATIONS.indexOf(a.termination) - TERMINATIONS.indexOf(b.termination),
    ),
    topOpenings: { white: openings.white, black: openings.black },
    latestGames: latestGames(at, OVERVIEW_LATEST_GAMES),
    activity: recentDays(at, OVERVIEW_ACTIVITY_DAYS),
    ratingSparkline: ratingSeries(at, { since: now - OVERVIEW_SPARKLINE_DAYS * DAY_MS, maxPoints: SPARKLINE_MAX_POINTS }),
  };
}
