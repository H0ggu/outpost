/**
 * One stored game with its PGN (`GET /api/games/:id`, PLAN §6).
 *
 * Access (PLAN §10): admins see every game. Anyone else (anonymous only when anonymous browsing
 * is on, which the route's preHandler decides) sees:
 * - a game stored in a database (PGN and reference games) only when they may read that database
 *   (`canReadDatabase`, the one database rule). Nothing else counts: a `pgn` source on a public
 *   profile never opens a private database (decision 6);
 * - a site game (Lichess, Chess.com) when a source of a profile they may read played it — a
 *   public profile's visible source, or any source of their own profile.
 * Otherwise the answer is 404, so private games don't reveal that they exist.
 */
import type { GameDetail, GamePlayer, GameResponse, Id } from '@outpost/shared/api';
import { isTitle } from '@outpost/shared/chess';
import type { Db } from '../db/index.ts';
import { notFound } from '../http/errors.ts';
import type { AuthUser } from '../http/types.ts';
import { canReadDatabase, type DatabaseAccessRow } from '../profiles/access.ts';
import { gameToPgn, parseHeaders, PGN_GAME_COLUMNS, pgnTags, type PgnGameRecord } from './pgnWriter.ts';

/** A `games` row with everything `GameDetail` and the PGN need. */
interface GameDetailRecord extends PgnGameRecord {
  origin_id: string;
  database_id: Id | null;
  white_key: string;
  black_key: string;
  accuracy_white: number | null;
  accuracy_black: number | null;
  ply_count: number;
  opening_ply: number | null;
}

/** True when `viewer` may read the stored game `game` (see the module comment). */
export function canViewGame(db: Db, game: { id: Id; database_id: Id | null }, viewer: AuthUser | null): boolean {
  if (viewer?.role === 'admin') return true;
  if (game.database_id !== null) {
    // Only the database decides: profiles reach database games through `pgn` / `fide` sources,
    // which never grant more than the database itself.
    const database = db.get<DatabaseAccessRow>('SELECT kind, visibility, owner_user_id FROM databases WHERE id = ?', [game.database_id]);
    return database !== undefined && canReadDatabase(database, viewer);
  }
  const viewerId = viewer?.id ?? -1;
  return (
    db.get(
      `SELECT 1 FROM player_games pg
         JOIN profile_sources ps ON ps.source_id = pg.source_id
         JOIN profiles p ON p.id = ps.profile_id
        WHERE pg.game_id = ? AND (p.owner_user_id = ? OR (p.visibility = 'public' AND ps.hidden = 0))
        LIMIT 1`,
      [game.id, viewerId],
    ) !== undefined
  );
}

const player = (
  name: string,
  key: string,
  rating: number | null,
  title: string | null,
  fideId: string | null,
  accuracy: number | null,
): GamePlayer => ({ name, key, rating, title: isTitle(title) ? title : null, fideId, accuracy });

/** `GET /api/games/:id`: the game and its PGN, or 404 when missing or not visible to `viewer`. */
export function loadGameForViewer(db: Db, id: Id, viewer: AuthUser | null): GameResponse {
  const r = db.get<GameDetailRecord>(
    `SELECT ${PGN_GAME_COLUMNS}, g.origin_id, g.database_id, g.white_key, g.black_key, g.accuracy_white,
            g.accuracy_black, g.ply_count, g.opening_ply
       FROM games g WHERE g.id = ?`,
    [id],
  );
  if (!r || !canViewGame(db, r, viewer)) throw notFound('Game not found');
  const stored = parseHeaders(r.headers_json);
  const game: GameDetail = {
    id: r.id,
    origin: r.origin,
    originId: r.origin_id,
    url: r.url,
    databaseId: r.database_id,
    white: player(r.white, r.white_key, r.white_rating, r.white_title, r.white_fide_id, r.accuracy_white),
    black: player(r.black, r.black_key, r.black_rating, r.black_title, r.black_fide_id, r.accuracy_black),
    result: r.result,
    termination: r.termination,
    timeClass: r.time_class,
    timeControl: r.time_control,
    rated: r.rated === 1,
    event: r.event,
    round: r.round,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    plies: r.ply_count,
    eco: r.eco,
    openingName: r.opening_name,
    openingPly: r.opening_ply,
    // The imported PGN's own headers; for games synced from a site API (no PGN headers stored),
    // the tags Outpost writes for it.
    headers: Object.fromEntries(stored.size > 0 ? stored : pgnTags(r)),
  };
  return { game, pgn: gameToPgn(r) };
}
