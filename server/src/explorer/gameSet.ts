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
  /** Stable text for result caches (derived sets over large databases are cached). */
  cacheKey: string;
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
});

/** All games matching `where` (over `games g`), seen from one side, or from both sides (UNION ALL). */
const derivedSet = (
  spec: GameSet['spec'],
  where: (side: Color) => { sql: string; params: SqlValue[] },
  opts: { perspective: GameSet['perspective']; cacheKey: string; bothSidesWhenUncoloured: boolean },
): GameSet => ({
  spec,
  source: 'derived',
  perspective: opts.perspective,
  sourceIds: [0],
  from(color) {
    const arm = (side: Color) => {
      const w = where(side);
      return { sql: `SELECT ${derivedColumns(side)} FROM games g WHERE ${w.sql}`, params: w.params };
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

/** Parses a `player` parameter or throws 400. */
export function parseSpecOrThrow(player: string): PlayerSpec {
  const spec = parsePlayerSpec(player.trim());
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
      });
    }
    case 'ref':
      return derivedSet(
        spec,
        side => ({ sql: `g.origin = 'reference' AND g.${side}_fide_id = ?`, params: [spec.fideId] }),
        { perspective: 'neutral', cacheKey: `ref:${spec.fideId}`, bothSidesWhenUncoloured: true },
      );
  }
}

/**
 * The reference databases as one set (`databaseId` null: every reference database), seen from
 * White's side. For the reference explorer and a reference-backed masters explorer.
 */
export function referenceGameSet(databaseId: Id | null): GameSet {
  return derivedSet(
    { kind: 'reference', databaseId },
    () =>
      databaseId === null
        ? { sql: `g.origin = 'reference'`, params: [] }
        : { sql: `g.database_id = ?`, params: [databaseId] },
    { perspective: 'neutral', cacheKey: `reference:${databaseId ?? 'all'}`, bothSidesWhenUncoloured: false },
  );
}

/**
 * Filters that make sense for a set. Derived sets over a whole database (db, reference) have no
 * player, so the player-perspective filters (`color`, `outcome`, `opp`, `oppName`, `src`) are dropped
 * for the masters-shaped explorers; the player explorer keeps them relative to the explorer colour.
 */
export function neutralFilters(f: ProfileFilters): ProfileFilters {
  const { color: _c, outcome: _o, opp: _p, oppName: _n, src: _s, ...rest } = f;
  return rest;
}
