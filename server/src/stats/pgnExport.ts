/**
 * PGN bulk export of a profile's filtered games (`GET /api/profiles/:slug/games.pgn`, PLAN §5/§6).
 *
 * - At most `PGN_EXPORT_MAX` games: the newest ones, written newest first (the games-tab order).
 * - Player names are normalised to the account name (ChessMonitor's rule): the profile's side of
 *   every game is written as the display name of the source (account) that played it, so OTB
 *   spellings such as "Carlsen, M" / "Carlsen,Magnus" read as the FIDE or PGN player's one name,
 *   and a game between two of the profile's accounts keeps both. When two sources claim the same
 *   side (a FIDE id and a PGN name), the FIDE name wins, then the online account, then the lowest
 *   source id. Opponents keep their account / PGN name.
 * - A game that two of the profile's sources played (one account against another) is written once.
 * - Text is produced in batches so a 10,000-game export streams instead of building one string.
 */
import type { Color, Id, SourceKind } from '@outpost/shared/api';
import { colorFromChar, type ColorChar } from '@outpost/shared/chess';
import { PLAYER_GAMES_BY_PK, scopeWhere, type StatsScope } from './common.ts';
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

/** Which source's name a side takes when several of the profile's sources played it (lower first). */
const KIND_RANK: Record<SourceKind, number> = { fide: 0, lichess: 1, chesscom: 1, pgn: 2 };

interface SourceName {
  id: Id;
  rank: number;
  name: string;
}

/** Prepares the export of `scope`, the profile's sides written under their accounts' names. */
export function prepareProfilePgnExport(scope: StatsScope, max = PGN_EXPORT_MAX): PgnExport {
  const where = scopeWhere(scope);
  const total = scope.db.value<number>(`SELECT COUNT(DISTINCT pg.game_id) FROM ${PLAYER_GAMES_BY_PK} WHERE ${where.sql}`, where.params) ?? 0;
  const sourceNames = new Map(
    scope.db
      .all<{ id: Id; kind: SourceKind; display_name: string }>('SELECT id, kind, display_name FROM sources WHERE id IN (SELECT value FROM json_each(?))', [
        JSON.stringify(scope.sourceIds),
      ])
      .map(s => [s.id, { id: s.id, rank: KIND_RANK[s.kind], name: s.display_name }] as const),
  );
  const better = (a: SourceName, b: SourceName | undefined): boolean => !b || a.rank < b.rank || (a.rank === b.rank && a.id < b.id);
  // The profile's side(s) per game, newest first; LIMIT over rows (a game has at most 4: two sides × lichess-or-pgn and fide sources), then de-duplicate.
  const rows = scope.db.all<{ game_id: Id; source_id: Id; color: ColorChar }>(
    `SELECT pg.game_id, pg.source_id, pg.color FROM player_games pg WHERE ${where.sql} ORDER BY ${GAME_LIST_ORDER} LIMIT ?`,
    [...where.params, max * 4],
  );
  const sides = new Map<Id, Partial<Record<Color, SourceName>>>();
  for (const r of rows) {
    let s = sides.get(r.game_id);
    if (!s) {
      if (sides.size >= max) continue;
      s = {};
      sides.set(r.game_id, s);
    }
    const src = sourceNames.get(r.source_id);
    const color = colorFromChar(r.color);
    if (src && better(src, s[color])) s[color] = src;
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
              ...(mine.white ? { white: mine.white.name } : {}),
              ...(mine.black ? { black: mine.black.name } : {}),
            },
          })}\n`;
        }
        if (text) yield text;
      }
    },
  };
}
