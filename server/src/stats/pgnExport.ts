/**
 * PGN bulk export of a profile's filtered games (`GET /api/profiles/:slug/games.pgn`, PLAN §5/§6).
 *
 * - At most `PGN_EXPORT_MAX` games: the newest ones, written newest first (the games-tab order).
 * - Player names are normalised: the profile's side of every game is written as the profile's
 *   display name, so games from several accounts (or PGN spellings such as "Carlsen, M") read as
 *   one player in other tools. Opponents keep their account / PGN name.
 * - A game that two of the profile's sources played (one account against another) is written once.
 * - Text is produced in batches so a 10,000-game export streams instead of building one string.
 */
import type { Color, Id } from '@outpost/shared/api';
import { colorFromChar, type ColorChar } from '@outpost/shared/chess';
import { scopeWhere, type StatsScope } from './common.ts';
import { GAME_LIST_ORDER } from './games.ts';
import { gameToPgn, PGN_GAME_COLUMNS, type PgnGameRecord } from './pgnWriter.ts';

/** Most games in one export (PLAN §6). */
export const PGN_EXPORT_MAX = 10_000;
/** Games fetched and written per batch. */
const BATCH = 250;

/** A prepared export: counts are known before streaming starts. */
export interface PgnExport {
  /** Games matching the filters (may exceed what is exported). */
  total: number;
  /** Games written (≤ `PGN_EXPORT_MAX`). */
  exported: number;
  /** PGN text chunks; consume once. */
  chunks(): Generator<string>;
}

/** Prepares the export of `scope` with the profile player written as `playerName`. */
export function prepareProfilePgnExport(scope: StatsScope, playerName: string, max = PGN_EXPORT_MAX): PgnExport {
  const where = scopeWhere(scope);
  const total = scope.db.value<number>(`SELECT COUNT(DISTINCT pg.game_id) FROM player_games pg WHERE ${where.sql}`, where.params) ?? 0;
  // The profile's colour(s) per game, newest first; LIMIT over rows (a game has at most 4: two sides × lichess-or-pgn and fide sources), then de-duplicate.
  const rows = scope.db.all<{ game_id: Id; color: ColorChar }>(
    `SELECT pg.game_id, pg.color FROM player_games pg WHERE ${where.sql} ORDER BY ${GAME_LIST_ORDER} LIMIT ?`,
    [...where.params, max * 4],
  );
  const sides = new Map<Id, Set<Color>>();
  for (const r of rows) {
    let s = sides.get(r.game_id);
    if (!s) {
      if (sides.size >= max) continue;
      s = new Set();
      sides.set(r.game_id, s);
    }
    s.add(colorFromChar(r.color));
  }
  const ids = [...sides.keys()];
  const db = scope.db;

  return {
    total,
    exported: ids.length,
    *chunks() {
      for (let i = 0; i < ids.length; i += BATCH) {
        const batch = ids.slice(i, i + BATCH);
        const byId = new Map(
          db
            .all<PgnGameRecord>(`SELECT ${PGN_GAME_COLUMNS} FROM games g WHERE g.id IN (SELECT value FROM json_each(?))`, [
              JSON.stringify(batch),
            ])
            .map(r => [r.id, r] as const),
        );
        let text = '';
        for (const id of batch) {
          const r = byId.get(id);
          if (!r) continue; // deleted while streaming
          const mine = sides.get(id)!;
          text += `${gameToPgn(r, {
            names: {
              ...(mine.has('white') ? { white: playerName } : {}),
              ...(mine.has('black') ? { black: playerName } : {}),
            },
          })}\n`;
        }
        if (text) yield text;
      }
    },
  };
}
