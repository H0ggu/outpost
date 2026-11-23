/**
 * The explorers over Outpost's own data (PLAN §6):
 * - `player`: `/api/explorer/player` (and `/f/<filters>/player`) — Lichess player-explorer shape;
 * - `reference`: `/api/explorer/reference` and a reference-backed `/api/explorer/masters` — masters shape;
 * - `games`: `/api/explorer/games` — the games of a player spec that reach a position.
 *
 * All three apply the same conditions (`setConditions`), so the games list matches the explorer's
 * counts (it also lists games that ended exactly at the position, which have no move to count).
 * Results over whole databases (db:, ref:, reference) are cached in memory for a few minutes,
 * keyed by the data version, because a large reference DB at the start position is slow to sum.
 */
import type {
  Color,
  DbGameRow,
  ExplorerGamesPage,
  ExplorerMastersResponse,
  ExplorerPlayerResponse,
  GameRow,
  Id,
} from '@outpost/shared/api';
import { explorerQueryRestrictions, filtersKey, type ProfileFilters } from '@outpost/shared/filters';
import { getOpeningBook, type OpeningBook } from '../chess/openings.ts';
import type { Db } from '../db/index.ts';
import type { AuthUser } from '../http/types.ts';
import {
  DB_GAME_ROW_COLUMNS,
  GAME_ROW_SELECT,
  toDbGameRow,
  toGameRow,
  type DbGameRowRecord,
  type GameRowRecord,
} from '../stats/gameRows.ts';
import { neutralFilters, parseSpecOrThrow, referenceGameSet, resolveGameSet, type GameSet } from './gameSet.ts';
import { Lru } from './lru.ts';
import { collectHits, gamesAtPosition, setConditions, type PageHit } from './query.ts';
import { emptyPlayerResponse, EXPLORER_LIMITS, mastersResponse, playerResponse } from './responses.ts';
import { normalizeFen, resolvePosition } from './position.ts';

/** lila's explorer settings, as sent. */
export interface LilaRestrictionsInput {
  speeds?: string | undefined;
  modes?: string | undefined;
  since?: string | undefined;
  until?: string | undefined;
}

/** Input of the player explorer. */
export interface PlayerExplorerInput extends LilaRestrictionsInput {
  player: string;
  color: Color;
  fen?: string | undefined;
  play?: string | undefined;
  variant?: string | undefined;
  moves?: number | undefined;
  recentGames?: number | undefined;
  filters: ProfileFilters;
  viewer: AuthUser | null;
}

/** Input of the masters-shaped reference explorer. */
export interface ReferenceExplorerInput extends LilaRestrictionsInput {
  /** One reference database, or null for all of them. */
  databaseId: Id | null;
  fen?: string | undefined;
  play?: string | undefined;
  moves?: number | undefined;
  topGames?: number | undefined;
  filters: ProfileFilters;
}

/** Input of `/api/explorer/games`. */
export interface ExplorerGamesInput extends LilaRestrictionsInput {
  player: string;
  fen?: string | undefined;
  play?: string | undefined;
  filters: ProfileFilters;
  page: number;
  pageSize: number;
  viewer: AuthUser | null;
}

/** Variants the local explorers answer (lila sends `fromPosition` games as `standard`). */
const isStandard = (variant: string | undefined): boolean =>
  variant === undefined || variant === '' || variant === 'standard' || variant === 'fromPosition';

const clamp = (v: number | undefined, def: number, max: number): number =>
  v === undefined || !Number.isFinite(v) ? def : Math.max(0, Math.min(max, Math.floor(v)));

/** The local explorers (one per app). */
export interface LocalExplorer {
  player(input: PlayerExplorerInput): ExplorerPlayerResponse;
  reference(input: ReferenceExplorerInput): ExplorerMastersResponse;
  games(input: ExplorerGamesInput): ExplorerGamesPage;
  /** Drops cached results (tests, or after an import). */
  clearCache(): void;
}

export function createLocalExplorer(deps: { db: Db; openingsDir: string; now?: () => number }): LocalExplorer {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  let book: OpeningBook | null = null;
  const openings = (): OpeningBook => (book ??= getOpeningBook(deps.openingsDir));
  const results = new Lru<unknown>({ max: 300, ttlMs: 10 * 60_000, now });

  /** Changes whenever games are added or a database's game count changes. */
  const dataVersion = (): string => {
    const row = db.get<{ m: number | null; c: number | null }>(
      'SELECT (SELECT max(id) FROM games) AS m, (SELECT sum(game_count) FROM databases) AS c',
    );
    return `${row?.m ?? 0}:${row?.c ?? 0}`;
  };

  const cached = <T>(set: GameSet, parts: unknown[], compute: () => T): T => {
    if (set.source !== 'derived') return compute();
    const key = JSON.stringify([set.cacheKey, dataVersion(), ...parts]);
    const hit = results.get(key) as T | undefined;
    if (hit !== undefined) return hit;
    const value = compute();
    results.set(key, value);
    return value;
  };

  const restrictionsOf = (q: LilaRestrictionsInput) =>
    explorerQueryRestrictions({ speeds: q.speeds, modes: q.modes, since: q.since, until: q.until });

  return {
    player(input) {
      const set = resolveGameSet(db, parseSpecOrThrow(input.player), input.viewer);
      if (!isStandard(input.variant)) return emptyPlayerResponse(null);
      const position = resolvePosition(input.fen, input.play, openings());
      const restrictions = restrictionsOf(input);
      const moves = clamp(input.moves, EXPLORER_LIMITS.defaultMoves, EXPLORER_LIMITS.maxMoves);
      const recentGames = clamp(input.recentGames, EXPLORER_LIMITS.defaultRecentGames, EXPLORER_LIMITS.maxRecentGames);
      const parts = ['player', input.color, normalizeFen(input.fen ?? ''), position.line.join(','), filtersKey(input.filters), restrictions, moves, recentGames];
      return cached(set, parts, () => {
        const where = setConditions(set, input.filters, restrictions, { color: input.color, now: now() });
        const hits = collectHits(db, set, where, position.key, input.color);
        return playerResponse(db, openings(), position, hits, { moves, recentGames });
      });
    },

    reference(input) {
      const set = referenceGameSet(input.databaseId);
      const position = resolvePosition(input.fen, input.play, openings());
      const filters = neutralFilters(input.filters);
      const restrictions = restrictionsOf(input);
      const moves = clamp(input.moves, EXPLORER_LIMITS.defaultMoves, EXPLORER_LIMITS.maxMoves);
      const topGames = clamp(input.topGames, EXPLORER_LIMITS.defaultTopGames, EXPLORER_LIMITS.maxTopGames);
      const parts = ['reference', normalizeFen(input.fen ?? ''), position.line.join(','), filtersKey(filters), restrictions, moves, topGames];
      return cached(set, parts, () => {
        const where = setConditions(set, filters, restrictions, { color: null, now: now() });
        const hits = collectHits(db, set, where, position.key, null);
        return mastersResponse(db, openings(), position, hits, { moves, topGames });
      });
    },

    games(input) {
      const set = resolveGameSet(db, parseSpecOrThrow(input.player), input.viewer);
      const position = resolvePosition(input.fen, input.play, openings());
      const restrictions = restrictionsOf(input);
      const filters = { ...input.filters };
      // A database has no player: its "colour" only picks the side the other filters refer to.
      const color: Color | null = set.spec.kind === 'db' ? (filters.color ?? 'white') : (filters.color ?? null);
      const where = setConditions(set, filters, restrictions, { color: null, now: now() });
      const { total, hits } = gamesAtPosition(db, set, where, position.key, color, {
        offset: (input.page - 1) * input.pageSize,
        limit: input.pageSize,
      });
      const paging = { total, page: input.page, pageSize: input.pageSize };
      if (set.perspective === 'player') return { ...paging, perspective: 'player', games: playerRows(db, set, hits) };
      return { ...paging, perspective: 'neutral', games: neutralRows(db, hits) };
    },

    clearCache: () => results.clear(),
  };
}

/** `GameRow`s for hits of a player_games set, in hit order. */
function playerRows(db: Db, set: GameSet, hits: readonly PageHit[]): GameRow[] {
  const out: GameRow[] = [];
  for (const h of hits) {
    const r = db.get<GameRowRecord>(
      `${GAME_ROW_SELECT} WHERE pg.game_id = ? AND pg.color = ? AND pg.source_id IN (${set.sourceIds.map(() => '?').join(', ')}) LIMIT 1`,
      [h.gameId, h.color, ...set.sourceIds],
    );
    if (r) out.push(toGameRow(r));
  }
  return out;
}

/** `DbGameRow`s for hits, in hit order. */
function neutralRows(db: Db, hits: readonly PageHit[]): DbGameRow[] {
  if (hits.length === 0) return [];
  const rows = db.all<DbGameRowRecord>(
    `SELECT ${DB_GAME_ROW_COLUMNS} FROM games g WHERE g.id IN (${hits.map(() => '?').join(', ')})`,
    hits.map(h => h.gameId),
  );
  const byId = new Map(rows.map(r => [r.id, r]));
  return hits.map(h => byId.get(h.gameId)).filter((r): r is DbGameRowRecord => r !== undefined).map(toDbGameRow);
}
