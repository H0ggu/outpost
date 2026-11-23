/**
 * Event-name suggestions for the filters bar (`GET /api/profiles/:slug/events?q=`, decision 35):
 * the distinct `games.event` values of the profile's visible sources that contain `q`
 * (case-insensitive like the `event` filter, see filterSql.ts), events starting with `q` first,
 * then the most played. A game between two of the profile's sources counts once.
 */
import { EVENT_SUGGESTIONS_MAX, type EventsResponse, type Id } from '@outpost/shared/api';
import type { Db } from '../db/index.ts';
import { PLAYER_GAMES_BY_PK, scopeWhere } from './common.ts';
import { likeContains } from './filterSql.ts';

/** `LIKE … ESCAPE '\'` pattern for "starts with `s`". */
const likePrefix = (s: string): string => `${s.replace(/[\\%_]/g, c => `\\${c}`)}%`;

/** Suggestions for `q` (trimmed; empty = the most played events) over `sourceIds`. */
export function eventSuggestions(db: Db, sourceIds: readonly Id[], q: string, limit = EVENT_SUGGESTIONS_MAX): EventsResponse {
  const where = scopeWhere({ db, sourceIds, filters: {} });
  const text = q.trim();
  const rows = db.all<{ name: string; games: number }>(
    `SELECT g.event AS name, COUNT(DISTINCT g.id) AS games, MAX(g.event LIKE ? ESCAPE '\\') AS prefix
       FROM ${PLAYER_GAMES_BY_PK} JOIN games g ON g.id = pg.game_id
      WHERE ${where.sql} AND g.event IS NOT NULL AND g.event <> '' AND g.event LIKE ? ESCAPE '\\'
      GROUP BY g.event
      ORDER BY prefix DESC, games DESC, name
      LIMIT ?`,
    [likePrefix(text), ...where.params, likeContains(text), limit],
  );
  return { events: rows.map(r => ({ name: r.name, games: r.games })) };
}
