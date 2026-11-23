/**
 * Which games an explorer request reads (the `player` spec, PLAN §6), as a SQL row source aliased
 * `pg` with the columns of `player_games`, so `playerGamesWhere` (the one implementation of the
 * filter semantics) applies to every kind of set:
 *
 * - profile slug → `player_games` of the profile's sources visible to the viewer
 *   (`loadProfileForViewer`);
 * - `lichess:<user>` / `chesscom:<user>` → `player_games` of that local source, when the viewer may
 *   see it (attached, not hidden, to a profile the viewer may read; admins see all);
 * - `db:<id>` → every game of a database the viewer may read (`loadDatabaseForViewer`), seen from
 *   one side (the explorer's colour) so the player-perspective filters still mean something;
 * - `ref:<fideId>` → that FIDE player's games in the reference databases (instance-wide data);
 * - the reference explorer and a reference-backed masters explorer → every game of the reference
 *   databases (or of one), from White's side, with only the neutral filters applied.
 *
 * Derived sets use `source_id = 0`, so `playerGamesWhere` gets `sourceIds: [0]`.
 */
import type { Id } from '@outpost/shared/api';
import { colorChar, type Color } from '@outpost/shared/chess';
import { parsePlayerSpec, type PlayerSpec, type ProfileFilters } from '@outpost/shared/filters';
import type { Db, SqlValue } from '../db/index.ts';
import { notFound, validationError } from '../http/errors.ts';
import type { AuthUser } from '../http/types.ts';
import { loadDatabaseForViewer, loadProfileForViewer } from '../profiles/access.ts';

/** A row source aliased `pg` with player_games-compatible columns. */
export interface GameSet {
  /** The parsed spec (or `reference` for the reference / masters explorers). */
  spec: PlayerSpec | { kind: 'reference'; databaseId: Id | null };
  /** `player`: real player_games rows (GAME_ROW_SELECT applies); `derived`: a subquery over `games`. */
  source: 'player_games' | 'derived';
  /** Game lists: player-perspective rows (`GameRow`) or neutral rows (`DbGameRow`). */
  perspective: 'player' | 'neutral';
  /** Pass to `playerGamesWhere`. */
  sourceIds: Id[];
  /**
   * FROM item for one colour of the player (`pg.color` is then constant for derived sets), or for
   * both when `color` is null. Parameters come first in the final query.
   */
  from(color: Color | null): { sql: string; params: SqlValue[] };
  /** Stable text for result caches. */
  cacheKey: string;
  /** Rows of the set over both colours (cheap: index counts or `explorer_db_stats`); drives the query plan. */
  size(db: Db): number;
  /** Smallest and largest game id of the set (index lookups), or null when it is empty. */
  idRange(db: Db): { lo: Id; hi: Id } | null;
  /**
   * Changes whenever the set's games change (`explorer_db_stats` counters of its databases), so
   * results can be cached under it; null when not tracked (profile sets: not cached).
   */
  version(db: Db): string | null;
  /** Can one game be several rows of `from(color)` (both sides of an uncoloured query)? */
  multiRow(color: Color | null): boolean;
}

/** Player-perspective columns of a derived `pg` row over `games g`, from `side`'s point of view. */
const derivedColumns = (side: Color): string => {
  const me = side;
  const opp = side === 'white' ? 'black' : 'white';
  const win = side === 'white' ? '1-0' : '0-1';
  const loss = side === 'white' ? '0-1' : '1-0';
  return `0 AS source_id, g.id AS game_id, '${colorChar(side)}' AS color,
          CASE g.result WHEN '${win}' THEN 'w' WHEN '${loss}' THEN 'l' ELSE 'd' END AS outcome,
          g.${me}_rating AS rating, g.${opp}_rating AS opp_rating, g.${opp} AS opp_name, g.${opp}_key AS opp_key,
          g.ended_at AS ended_at, g.time_class AS time_class, g.rated AS rated`;
};

/** `player_games` for a list of source ids. */
const playerGamesSet = (spec: PlayerSpec, sourceIds: Id[]): GameSet => ({
  spec,
  source: 'player_games',
  perspective: 'player',
  sourceIds,
  from: () => ({ sql: 'player_games pg', params: [] }),
  cacheKey: `${spec.kind}:${sourceIds.join(',')}`,
  size: db =>
    sourceIds.length === 0
      ? 0
      : (db.value<number>(`SELECT count(*) FROM player_games WHERE source_id IN (${placeholders(sourceIds.length)})`, sourceIds) ?? 0),
  idRange: db => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const id of sourceIds) {
      const min = db.value<Id | null>('SELECT min(game_id) FROM player_games WHERE source_id = ?', [id]);
      const max = db.value<Id | null>('SELECT max(game_id) FROM player_games WHERE source_id = ?', [id]);
      if (min != null && max != null) {
        lo = Math.min(lo, min);
        hi = Math.max(hi, max);
      }
    }
    return lo <= hi ? { lo, hi } : null;
  },
  version: () => null,
  multiRow: color => color === null && sourceIds.length > 1,
});

const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

/** Games and change counter of some databases (`explorer_db_stats`, kept by triggers on `games`). */
function databaseStats(db: Db, ids: readonly Id[]): { games: number; version: string } {
  if (ids.length === 0) return { games: 0, version: '-' };
  const rows = db.all<{ database_id: Id; games: number; changes: number }>(
    `SELECT database_id, games, changes FROM explorer_db_stats WHERE database_id IN (${placeholders(ids.length)}) ORDER BY database_id`,
    ids,
  );
  const byId = new Map(rows.map(r => [r.database_id, r]));
  return {
    games: rows.reduce((s, r) => s + r.games, 0),
    version: ids.map(id => `${id}.${byId.get(id)?.changes ?? 0}`).join(','),
  };
}

/** Smallest and largest game id of some databases (the covering index `games_explorer_db`). */
function databaseIdRange(db: Db, ids: readonly Id[]): { lo: Id; hi: Id } | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const id of ids) {
    const min = db.value<Id | null>('SELECT min(id) FROM games WHERE database_id = ?', [id]);
    const max = db.value<Id | null>('SELECT max(id) FROM games WHERE database_id = ?', [id]);
    if (min != null && max != null) {
      lo = Math.min(lo, min);
      hi = Math.max(hi, max);
    }
  }
  return lo <= hi ? { lo, hi } : null;
}

/** Ids of the reference databases. */
const referenceDatabaseIds = (db: Db): Id[] =>
  db.all<{ id: Id }>(`SELECT id FROM databases WHERE kind = 'reference' ORDER BY id`).map(r => r.id);

/** Set statistics of a derived set (see `GameSet`). */
interface DerivedStats {
  size(db: Db): number;
  idRange(db: Db): { lo: Id; hi: Id } | null;
  version(db: Db): string | null;
}

/** Stats of a derived set over whole databases. */
const databasesStats = (ids: (db: Db) => Id[]): DerivedStats => ({
  size: db => databaseStats(db, ids(db)).games,
  idRange: db => databaseIdRange(db, ids(db)),
  version: db => databaseStats(db, ids(db)).version,
});

/** All games matching `where` (over `games g`), seen from one side, or from both sides (UNION ALL). */
const derivedSet = (
  spec: GameSet['spec'],
  where: (side: Color) => { sql: string; params: SqlValue[] },
  opts: {
    perspective: GameSet['perspective'];
    cacheKey: string;
    bothSidesWhenUncoloured: boolean;
    stats: DerivedStats;
    /** Membership is by `database_id`: read `games_explorer_db`, never the wide rows (SQLite would pick the rowid). */
    byDatabase: boolean;
  },
): GameSet => ({
  spec,
  source: 'derived',
  perspective: opts.perspective,
  sourceIds: [0],
  from(color) {
    const arm = (side: Color) => {
      const w = where(side);
      const table = opts.byDatabase ? 'games g INDEXED BY games_explorer_db' : 'games g';
      return { sql: `SELECT ${derivedColumns(side)} FROM ${table} WHERE ${w.sql}`, params: w.params };
    };
    if (color !== null || !opts.bothSidesWhenUncoloured) {
      const a = arm(color ?? 'white');
      return { sql: `(${a.sql}) pg`, params: a.params };
    }
    const w = arm('white');
    const b = arm('black');
    return { sql: `(${w.sql} UNION ALL ${b.sql}) pg`, params: [...w.params, ...b.params] };
  },
  cacheKey: opts.cacheKey,
  size: opts.stats.size,
  idRange: opts.stats.idRange,
  version: opts.stats.version,
  multiRow: color => color === null && opts.bothSidesWhenUncoloured,
});

/** Is a lichess/chesscom source visible to `viewer` (attached, not hidden, to a profile they may read)? */
function sourceVisible(db: Db, sourceId: Id, viewer: AuthUser | null): boolean {
  if (viewer?.role === 'admin') return true;
  const row = db.get(
    `SELECT 1 AS ok
       FROM profile_sources ps JOIN profiles p ON p.id = ps.profile_id
      WHERE ps.source_id = ?
        AND ((p.visibility = 'public' AND ps.hidden = 0) OR (? IS NOT NULL AND p.owner_user_id = ?))
      LIMIT 1`,
    [sourceId, viewer?.id ?? null, viewer?.id ?? null],
  );
  return row !== undefined;
}

/** Parses a `player` parameter or throws 400. Slugs are lowercase, so a bare name is lowercased first. */
export function parseSpecOrThrow(player: string): PlayerSpec {
  const raw = player.trim();
  const spec = parsePlayerSpec(raw.includes(':') ? raw : raw.toLowerCase());
  if (!spec) {
    throw validationError('player: expected a profile slug, lichess:<user>, chesscom:<user>, db:<id> or ref:<fideId>');
  }
  return spec;
}

/**
 * Resolves a player spec for `viewer`. Throws 404 when the profile / source / database does not
 * exist or is not visible (private objects don't leak their existence).
 */
export function resolveGameSet(db: Db, spec: PlayerSpec, viewer: AuthUser | null): GameSet {
  switch (spec.kind) {
    case 'profile': {
      const profile = loadProfileForViewer(db, spec.slug, viewer);
      return playerGamesSet(spec, profile.sourceIds);
    }
    case 'lichess':
    case 'chesscom': {
      const id = db.value<Id>('SELECT id FROM sources WHERE kind = ? AND key = ?', [spec.kind, spec.username]);
      if (id === undefined || !sourceVisible(db, id, viewer)) {
        throw notFound(`No games of ${spec.kind}:${spec.username} in Outpost; add the account to a profile first`);
      }
      return playerGamesSet(spec, [id]);
    }
    case 'db': {
      const database = loadDatabaseForViewer(db, spec.databaseId, viewer);
      return derivedSet(spec, () => ({ sql: 'g.database_id = ?', params: [database.id] }), {
        perspective: 'neutral',
        cacheKey: `db:${database.id}`,
        bothSidesWhenUncoloured: false,
        stats: databasesStats(() => [database.id]),
        byDatabase: true,
      });
    }
    case 'ref':
      return derivedSet(
        spec,
        side => ({ sql: `g.origin = 'reference' AND g.${side}_fide_id = ?`, params: [spec.fideId] }),
        { perspective: 'neutral', cacheKey: `ref:${spec.fideId}`, bothSidesWhenUncoloured: true, stats: fideStats(spec.fideId), byDatabase: false },
      );
  }
}

/**
 * The reference databases as one set (`databaseId` null: every reference database, as they are
 * now), seen from White's side. For the reference explorer and a reference-backed masters
 * explorer. Membership is by database (`games_explorer_db` covers it), not by `origin`.
 */
export function referenceGameSet(db: Db, databaseId: Id | null): GameSet {
  const ids = databaseId === null ? referenceDatabaseIds(db) : [databaseId];
  return derivedSet(
    { kind: 'reference', databaseId },
    () =>
      ids.length === 0
        ? { sql: '0', params: [] }
        : { sql: ids.length === 1 ? 'g.database_id = ?' : `g.database_id IN (${placeholders(ids.length)})`, params: ids },
    {
      perspective: 'neutral',
      cacheKey: `reference:${databaseId ?? 'all'}`,
      bothSidesWhenUncoloured: false,
      stats: databasesStats(() => ids),
      byDatabase: ids.length > 0,
    },
  );
}

/** Stats of a FIDE player's reference games (small sets; versioned with every reference database). */
const fideStats = (fideId: string): DerivedStats => ({
  size: db =>
    db.value<number>(
      `SELECT (SELECT count(*) FROM games WHERE white_fide_id = ?1 AND origin = 'reference')
            + (SELECT count(*) FROM games WHERE black_fide_id = ?1 AND origin = 'reference')`,
      [fideId],
    ) ?? 0,
  idRange: db => {
    const r = db.get<{ lo: Id | null; hi: Id | null }>(
      `SELECT min(id) AS lo, max(id) AS hi FROM games WHERE origin = 'reference' AND (white_fide_id = ?1 OR black_fide_id = ?1)`,
      [fideId],
    );
    return r?.lo != null && r.hi != null ? { lo: r.lo, hi: r.hi } : null;
  },
  version: db => `ref.${databaseStats(db, referenceDatabaseIds(db)).version}`,
});

/**
 * Filters that make sense for a set. Derived sets over a whole database (db, reference) have no
 * player, so the player-perspective filters (`color`, `outcome`, `opp`, `oppName`, `src`) are dropped
 * for the masters-shaped explorers; the player explorer keeps them relative to the explorer colour.
 */
export function neutralFilters(f: ProfileFilters): ProfileFilters {
  const { color: _c, outcome: _o, opp: _p, oppName: _n, src: _s, ...rest } = f;
  return rest;
}
