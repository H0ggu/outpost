/**
 * Hits → Lichess-shaped explorer responses (lila's `OpeningData`, research lichess-api.md §3):
 * - player explorer (`ExplorerPlayerResponse`): moves with white/draws/black (absolute results, the
 *   same orientation as Lichess), `averageOpponentRating`, `performance`, a game ref when exactly
 *   one game played the move, and `recentGames`;
 * - masters shape (`ExplorerMastersResponse`, the local reference DB): moves with `averageRating`
 *   and `topGames` (highest average rating first).
 *
 * Like lila-openingexplorer, totals are the sums over the moves: a game that ended exactly at the
 * position has no move from it and is not counted there.
 */
import {
  toExplorerGameId,
  type ExplorerGamePlayer,
  type ExplorerGameRef,
  type ExplorerMastersResponse,
  type ExplorerMove,
  type ExplorerOpening,
  type ExplorerPlayerMove,
  type ExplorerPlayerResponse,
  type Id,
} from '@outpost/shared/api';
import { isTitle, winnerOf, type GameResult, type TimeClass } from '@outpost/shared/chess';
import type { Chess } from 'chessops/chess';
import type { OpeningBook } from '../chess/openings.ts';
import type { Db } from '../db/index.ts';
import { describeMove, type ExplorerPosition } from './position.ts';
import { hitWinner, type Hit } from './query.ts';

/** Lichess defaults and caps. */
export const EXPLORER_LIMITS = {
  /** `moves`: Lichess returns 12 by default. */
  defaultMoves: 12,
  maxMoves: 100,
  /** Player explorer `recentGames` (Lichess default and maximum 8; Outpost allows a few more). */
  defaultRecentGames: 8,
  maxRecentGames: 20,
  /** Masters `topGames` (Lichess default and maximum 15). */
  defaultTopGames: 15,
  maxTopGames: 15,
} as const;

// ---------------------------------------------------------------------------
// Performance rating
// ---------------------------------------------------------------------------

/**
 * FIDE rating difference `dp` for a score fraction p ≥ 0.5, from the FIDE Handbook (B.02, 8.1.2
 * table), indexed by round(p × 100) − 50. Scores below ½ use −dp(1 − p).
 */
const FIDE_DP = [
  0, 7, 14, 21, 29, 36, 43, 50, 57, 65, 72, 80, 87, 95, 102, 110, 117, 125, 133, 141, 149, 158, 166, 175, 184, 193, 202, 211,
  220, 230, 240, 251, 262, 273, 284, 296, 309, 322, 336, 351, 366, 383, 401, 422, 444, 470, 501, 538, 589, 677, 800,
] as const;

/** FIDE `dp` for a score fraction in [0, 1]. */
export const fideDp = (score: number): number => {
  const p = Math.min(1, Math.max(0, score));
  const idx = Math.round(Math.abs(p - 0.5) * 100);
  const dp = FIDE_DP[Math.min(idx, 50)]!;
  return p >= 0.5 ? dp : -dp;
};

/** Performance rating: average opponent rating + FIDE dp(score). */
export const performanceRating = (avgOpponent: number, score: number): number => Math.round(avgOpponent + fideDp(score));

// ---------------------------------------------------------------------------
// Game refs
// ---------------------------------------------------------------------------

interface GameInfoRow {
  id: Id;
  white: string;
  black: string;
  white_rating: number | null;
  black_rating: number | null;
  white_title: string | null;
  black_title: string | null;
  result: GameResult;
  time_class: TimeClass;
  rated: number;
  ended_at: number | null;
  started_at: number | null;
}

/** Loads what game refs need for some games. */
export function loadGameInfo(db: Db, ids: readonly Id[]): Map<Id, GameInfoRow> {
  const out = new Map<Id, GameInfoRow>();
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += 500) {
    const chunk = unique.slice(i, i + 500);
    const rows = db.all<GameInfoRow>(
      `SELECT id, white, black, white_rating, black_rating, white_title, black_title, result, time_class, rated, ended_at, started_at
         FROM games WHERE id IN (${chunk.map(() => '?').join(', ')})`,
      chunk,
    );
    for (const r of rows) out.set(r.id, r);
  }
  return out;
}

const explorerPlayer = (name: string, rating: number | null, title: string | null): ExplorerGamePlayer => ({
  name,
  rating: rating ?? 0,
  ...(isTitle(title) ? { title } : {}),
});

/** A stored game as a Lichess explorer game ref (`id` = `op<id>`). `withSpeed` adds speed and mode (lichess/player shape). */
export function toGameRef(g: GameInfoRow, opts: { uci?: string | null; withSpeed: boolean }): ExplorerGameRef {
  const at = g.ended_at ?? g.started_at;
  const d = at === null ? null : new Date(at);
  return {
    ...(opts.uci ? { uci: opts.uci } : {}),
    id: toExplorerGameId(g.id),
    winner: winnerOf(g.result),
    ...(opts.withSpeed && g.time_class !== 'unknown' ? { speed: g.time_class } : {}),
    ...(opts.withSpeed ? { mode: g.rated === 1 ? ('rated' as const) : ('casual' as const) } : {}),
    white: explorerPlayer(g.white, g.white_rating, g.white_title),
    black: explorerPlayer(g.black, g.black_rating, g.black_title),
    year: d ? d.getUTCFullYear() : 0,
    month: d ? `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}` : null,
  };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

interface MoveAcc {
  uci: string;
  san: string;
  opening: ExplorerOpening | null;
  white: number;
  draws: number;
  black: number;
  games: number;
  /** Player explorer: opponents' ratings and the player's score over those games. */
  oppSum: number;
  oppN: number;
  score: number;
  /** Masters shape: every known rating of both players. */
  ratingSum: number;
  ratingN: number;
  lastPlayed: number | null;
  lastGameId: Id;
}

const total = (m: { white: number; draws: number; black: number }): number => m.white + m.draws + m.black;

/** Groups hits by move (dropping games that ended at the position and moves illegal there). */
function aggregate(pos: Chess, book: OpeningBook, hits: readonly Hit[]): { moves: MoveAcc[]; valid: Hit[] } {
  const byUci = new Map<string, MoveAcc | null>();
  const valid: Hit[] = [];
  for (const h of hits) {
    if (h.nextUci === null) continue;
    let acc = byUci.get(h.nextUci);
    if (acc === undefined) {
      const d = describeMove(pos, h.nextUci, book);
      acc = d
        ? {
            uci: d.uci,
            san: d.san,
            opening: d.opening,
            white: 0,
            draws: 0,
            black: 0,
            games: 0,
            oppSum: 0,
            oppN: 0,
            score: 0,
            ratingSum: 0,
            ratingN: 0,
            lastPlayed: null,
            lastGameId: h.gameId,
          }
        : null;
      byUci.set(h.nextUci, acc);
    }
    if (acc === null) continue;
    valid.push(h);
    const winner = hitWinner(h);
    if (winner === 'white') acc.white++;
    else if (winner === 'black') acc.black++;
    else acc.draws++;
    acc.games++;
    if (h.oppRating !== null) {
      acc.oppSum += h.oppRating;
      acc.oppN++;
      acc.score += h.outcome === 'w' ? 1 : h.outcome === 'd' ? 0.5 : 0;
    }
    for (const r of [h.rating, h.oppRating]) {
      if (r !== null) {
        acc.ratingSum += r;
        acc.ratingN++;
      }
    }
    if (acc.games === 1 || (h.endedAt ?? -Infinity) > (acc.lastPlayed ?? -Infinity)) {
      acc.lastPlayed = h.endedAt ?? acc.lastPlayed;
      acc.lastGameId = h.gameId;
    }
  }
  const moves = [...byUci.values()].filter((m): m is MoveAcc => m !== null);
  moves.sort(
    (a, b) => total(b) - total(a) || (b.lastPlayed ?? -Infinity) - (a.lastPlayed ?? -Infinity) || (a.uci < b.uci ? -1 : a.uci > b.uci ? 1 : 0),
  );
  return { moves, valid };
}

const sumTotals = (moves: readonly MoveAcc[]) =>
  moves.reduce((s, m) => ({ white: s.white + m.white, draws: s.draws + m.draws, black: s.black + m.black }), {
    white: 0,
    draws: 0,
    black: 0,
  });

const byRecent = (a: Hit, b: Hit): number => (b.endedAt ?? -Infinity) - (a.endedAt ?? -Infinity) || b.gameId - a.gameId;

/** `ExplorerPlayerResponse` (one NDJSON line) for hits at a position. */
export function playerResponse(
  db: Db,
  book: OpeningBook,
  position: ExplorerPosition,
  hits: readonly Hit[],
  opts: { moves: number; recentGames: number },
): ExplorerPlayerResponse {
  const { moves, valid } = aggregate(position.pos, book, hits);
  const totals = sumTotals(moves);
  const shown = moves.slice(0, opts.moves);
  const recent = [...valid].sort(byRecent).slice(0, opts.recentGames);
  const single = shown.filter(m => m.games === 1).map(m => m.lastGameId);
  const info = loadGameInfo(db, [...single, ...recent.map(h => h.gameId)]);
  const ref = (id: Id, uci?: string | null): ExplorerGameRef | null => {
    const g = info.get(id);
    return g ? toGameRef(g, { uci: uci ?? null, withSpeed: true }) : null;
  };
  const outMoves: ExplorerPlayerMove[] = shown.map(m => {
    const avgOpp = m.oppN ? Math.round(m.oppSum / m.oppN) : 0;
    return {
      uci: m.uci,
      san: m.san,
      averageOpponentRating: avgOpp,
      performance: m.oppN ? performanceRating(m.oppSum / m.oppN, m.score / m.oppN) : 0,
      white: m.white,
      draws: m.draws,
      black: m.black,
      game: m.games === 1 ? ref(m.lastGameId) : null,
      opening: m.opening,
      ...(m.lastPlayed !== null ? { lastPlayed: m.lastPlayed } : {}),
    };
  });
  return {
    opening: position.opening,
    queuePosition: 0,
    white: totals.white,
    draws: totals.draws,
    black: totals.black,
    moves: outMoves,
    recentGames: recent.map(h => ref(h.gameId, h.nextUci)).filter((g): g is ExplorerGameRef => g !== null),
  };
}

/** Average of the known ratings of both players, or null. */
const hitAverageRating = (h: Hit): number | null =>
  h.rating !== null && h.oppRating !== null ? (h.rating + h.oppRating) / 2 : (h.rating ?? h.oppRating);

/** `ExplorerMastersResponse` (masters shape) for hits at a position. */
export function mastersResponse(
  db: Db,
  book: OpeningBook,
  position: ExplorerPosition,
  hits: readonly Hit[],
  opts: { moves: number; topGames: number },
): ExplorerMastersResponse {
  const { moves, valid } = aggregate(position.pos, book, hits);
  const totals = sumTotals(moves);
  const shown = moves.slice(0, opts.moves);
  const top = [...valid]
    .sort((a, b) => (hitAverageRating(b) ?? -Infinity) - (hitAverageRating(a) ?? -Infinity) || byRecent(a, b))
    .slice(0, opts.topGames);
  const single = shown.filter(m => m.games === 1).map(m => m.lastGameId);
  const info = loadGameInfo(db, [...single, ...top.map(h => h.gameId)]);
  const ref = (id: Id, uci?: string | null): ExplorerGameRef | null => {
    const g = info.get(id);
    return g ? toGameRef(g, { uci: uci ?? null, withSpeed: false }) : null;
  };
  const outMoves: ExplorerMove[] = shown.map(m => ({
    uci: m.uci,
    san: m.san,
    averageRating: m.ratingN ? Math.round(m.ratingSum / m.ratingN) : 0,
    white: m.white,
    draws: m.draws,
    black: m.black,
    game: m.games === 1 ? ref(m.lastGameId) : null,
    opening: m.opening,
  }));
  return {
    opening: position.opening,
    white: totals.white,
    draws: totals.draws,
    black: totals.black,
    moves: outMoves,
    topGames: top.map(h => ref(h.gameId, h.nextUci)).filter((g): g is ExplorerGameRef => g !== null),
  };
}

/** An empty response (non-standard variants: Outpost stores standard chess only). */
export const emptyPlayerResponse = (opening: ExplorerOpening | null): ExplorerPlayerResponse => ({
  opening,
  queuePosition: 0,
  white: 0,
  draws: 0,
  black: 0,
  moves: [],
  recentGames: [],
});
