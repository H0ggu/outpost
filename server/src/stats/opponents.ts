/**
 * Opponents tab (`GET /api/profiles/:slug/opponents`, PLAN §5 "Opponents").
 *
 * An opponent is `(opp_source_kind, opp_key)`: an account on the site the game was played on,
 * a FIDE id, or a PGN name. Name, title and rating come from the latest game against them;
 * country (and a title the games lack) from `players_cache`.
 *
 * - `most`: every opponent, most games first.
 * - `titled`: opponents with a title (BOT accounts are not "famous"), most games first.
 */
import type { OpponentRow, OpponentsPage, SourceKind } from '@outpost/shared/api';
import { isTitle } from '@outpost/shared/chess';
import type { Db } from '../db/index.ts';
import type { AuthUser } from '../http/types.ts';
import { PLAYER_GAMES_BY_PK, scopeWhere, wdlColumns, type StatsScope } from './common.ts';
import { normalizeCountry } from './country.ts';

/** Default and largest page sizes. */
export const OPPONENTS_PAGE_SIZE = 20;
export const OPPONENTS_MAX_PAGE_SIZE = 100;

interface OpponentRecord {
  kind: SourceKind;
  key: string;
  name: string;
  games: number;
  w: number;
  d: number;
  l: number;
  last: number | null;
  rating: number | null;
  title: string | null;
  country: string | null;
  total: number;
}

/**
 * Slug of a profile the viewer may open that contains this account (own profiles first, then
 * public ones; a hidden source counts only for its editors). `pgn` opponents never match: their
 * key is a name, not a source key.
 */
export function profileSlugFor(db: Db, kind: SourceKind, key: string, viewer: AuthUser | null): string | null {
  if (kind === 'pgn') return null;
  const isAdmin = viewer?.role === 'admin';
  const viewerId = viewer?.id ?? -1;
  return (
    db.value<string>(
      `SELECT p.slug FROM sources s
         JOIN profile_sources ps ON ps.source_id = s.id
         JOIN profiles p ON p.id = ps.profile_id
        WHERE s.kind = ? AND s.key = ?
          AND (? OR p.owner_user_id = ? OR (p.visibility = 'public' AND ps.hidden = 0))
        ORDER BY p.owner_user_id = ? DESC, p.visibility = 'public' DESC, p.id
        LIMIT 1`,
      [kind, key, isAdmin, viewerId, viewerId],
    ) ?? null
  );
}

/** One page of opponents. */
export function opponentsPage(
  scope: StatsScope,
  opts: { view: 'most' | 'titled'; page: number; pageSize: number; viewer: AuthUser | null },
): OpponentsPage {
  const where = scopeWhere(scope);
  const titled = opts.view === 'titled';
  // One pass groups the games per opponent (bare columns come from the latest game: SQLite takes
  // them from the row that holds MAX(ended_at)); the cache is joined per opponent, not per game.
  const rows = scope.db.all<OpponentRecord>(
    `WITH o AS (
        SELECT pg.opp_source_kind AS kind, pg.opp_key AS key, COUNT(*) AS games, ${wdlColumns()},
               MAX(pg.ended_at) AS last, pg.opp_name AS name, pg.opp_rating AS rating, pg.opp_title AS title
          FROM ${PLAYER_GAMES_BY_PK}
         WHERE ${where.sql}
         GROUP BY pg.opp_source_kind, pg.opp_key)
      SELECT o.kind, o.key, o.name, o.games, o.w, o.d, o.l, o.last, o.rating,
             COALESCE(o.title, pc.title) AS title, pc.country AS country, COUNT(*) OVER () AS total
        FROM o LEFT JOIN players_cache pc ON pc.kind = o.kind AND pc.key = o.key
       WHERE ? = 0 OR (COALESCE(o.title, pc.title) IS NOT NULL AND COALESCE(o.title, pc.title) <> 'BOT')
       ORDER BY o.games DESC, o.last DESC, o.key
       LIMIT ? OFFSET ?`,
    [...where.params, titled ? 1 : 0, opts.pageSize, (opts.page - 1) * opts.pageSize],
  );
  let total = rows[0]?.total;
  if (total === undefined) {
    // Past the last page: count without paging.
    total =
      opts.page > 1
        ? (scope.db.value<number>(
            `SELECT COUNT(*) FROM (
               SELECT pg.opp_source_kind AS kind, pg.opp_key AS key, MAX(pg.ended_at), pg.opp_title AS title
                 FROM ${PLAYER_GAMES_BY_PK} WHERE ${where.sql} GROUP BY 1, 2) o
               LEFT JOIN players_cache pc ON pc.kind = o.kind AND pc.key = o.key
              WHERE ? = 0 OR (COALESCE(o.title, pc.title) IS NOT NULL AND COALESCE(o.title, pc.title) <> 'BOT')`,
            [...where.params, titled ? 1 : 0],
          ) ?? 0)
        : 0;
  }
  return {
    total,
    page: opts.page,
    pageSize: opts.pageSize,
    rows: rows.map(
      (r): OpponentRow => ({
        key: r.key,
        name: r.name,
        kind: r.kind,
        title: isTitle(r.title) ? r.title : null,
        country: normalizeCountry(r.country),
        games: r.games,
        w: r.w,
        d: r.d,
        l: r.l,
        lastRating: r.rating,
        lastPlayed: r.last,
        profileSlug: profileSlugFor(scope.db, r.kind, r.key, opts.viewer),
      }),
    ),
  };
}

