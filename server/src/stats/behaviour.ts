/**
 * Win / draw / loss behaviour (`GET /api/profiles/:slug/behaviour`, PLAN §5 "Opponents"): how the
 * profile player's wins, draws and losses ended, with each termination's share of that outcome
 * and the average game length in full moves. Terminations read from the player's side: a
 * `timeout` among wins means the opponent flagged.
 *
 * The same one-pass query (outcome × termination, plus time class and colour) also feeds the
 * overview, which needs the termination × result table and the per-class / per-colour totals.
 */
import type { BehaviourRow, BehaviourStats, Color, Outcome, Termination, TimeClass } from '@outpost/shared/api';
import { colorFromChar, TERMINATIONS, type ColorChar } from '@outpost/shared/chess';
import { round, scopeWhere, type StatsScope } from './common.ts';

/** One cell of the outcome × termination × time class × colour breakdown. */
export interface OutcomeCell {
  outcome: Outcome;
  termination: Termination;
  timeClass: TimeClass;
  color: Color;
  games: number;
  /** Sum of the games' lengths in full moves. */
  moves: number;
}

/** Outcome × termination × time class × colour counts of a scope (one pass over the games). */
export function outcomeBreakdown(scope: StatsScope): OutcomeCell[] {
  const where = scopeWhere(scope);
  return scope.db
    .all<{ outcome: Outcome; termination: Termination; time_class: TimeClass; color: ColorChar; games: number; moves: number }>(
      `SELECT pg.outcome AS outcome, g.termination AS termination, pg.time_class AS time_class, pg.color AS color,
              COUNT(*) AS games, SUM((g.ply_count + 1) / 2) AS moves
         FROM player_games pg JOIN games g ON g.id = pg.game_id
        WHERE ${where.sql}
        GROUP BY 1, 2, 3, 4`,
      where.params,
    )
    .map(r => ({
      outcome: r.outcome,
      termination: r.termination,
      timeClass: r.time_class,
      color: colorFromChar(r.color),
      games: r.games,
      moves: r.moves,
    }));
}

/** Behaviour tables from a breakdown. */
export function behaviourFromCells(cells: readonly OutcomeCell[]): BehaviourStats {
  const out: BehaviourStats = { w: [], d: [], l: [] };
  for (const outcome of ['w', 'd', 'l'] as const) {
    const byTerm = new Map<Termination, { count: number; moves: number }>();
    let total = 0;
    for (const c of cells) {
      if (c.outcome !== outcome) continue;
      total += c.games;
      const t = byTerm.get(c.termination) ?? { count: 0, moves: 0 };
      t.count += c.games;
      t.moves += c.moves;
      byTerm.set(c.termination, t);
    }
    out[outcome] = [...byTerm]
      .map(
        ([termination, t]): BehaviourRow => ({
          termination,
          count: t.count,
          pct: round((100 * t.count) / total, 1),
          avgMoves: round(t.moves / t.count, 1),
        }),
      )
      .sort((a, b) => b.count - a.count || TERMINATIONS.indexOf(a.termination) - TERMINATIONS.indexOf(b.termination));
  }
  return out;
}

/** Behaviour stats of a scope. */
export const behaviourStats = (scope: StatsScope): BehaviourStats => behaviourFromCells(outcomeBreakdown(scope));
