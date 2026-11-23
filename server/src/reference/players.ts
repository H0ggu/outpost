/**
 * The reference player index (`reference_players`, migration 600): one row per FIDE id across all
 * reference databases, and one per (database, name) for players without a FIDE id. Maintained by the
 * importer for every newly stored game; game deletions are counted down by a trigger.
 *
 * Search (`GET /api/reference/players`, unified search) matches FIDE id prefixes, or every word of
 * the query against the start of a word of the folded name, so "magnus carlsen", "carlsen" and
 * "Carlsen, M" all find "Carlsen, Magnus".
 */
import type { EpochMs, Id, ReferencePlayer, Title } from '@outpost/shared/api';
import { isTitle, playerKey } from '@outpost/shared/chess';
import { pgnSourceKey } from '../chess/index.ts';
import type { Db } from '../db/index.ts';
import type { AuthUser } from '../http/types.ts';

/** Default and maximum number of search results. */
export const PLAYER_SEARCH_DEFAULT_LIMIT = 20;
export const PLAYER_SEARCH_MAX_LIMIT = 50;
/** Longest query considered (longer input is cut). */
export const PLAYER_SEARCH_MAX_QUERY = 100;
const MAX_TOKENS = 6;

const FOLD_MAP: Record<string, string> = {
  ø: 'o',
  æ: 'ae',
  œ: 'oe',
  ß: 'ss',
  đ: 'd',
  ł: 'l',
  þ: 'th',
  ð: 'd',
  ı: 'i',
};

/**
 * Folds a name for search: Unicode compatibility form without accents, lowercase ASCII letters and
 * digits, words separated by single spaces ("Carlsen, Magnus" → "carlsen magnus", "Ødegård" → "odegard").
 * Non-Latin scripts keep their letters (lowercased).
 */
export function foldName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[øæœßđłþðı]/g, c => FOLD_MAP[c] ?? c)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** One side of a stored game as the index sees it. */
export interface IndexedPlayer {
  name: string;
  fideId: string | null;
  title: Title | null;
  rating: number | null;
  federation: string | null;
}

interface PlayerRow {
  id: Id;
  fide_id: string | null;
  database_id: Id | null;
  name_key: string;
  name: string;
  title: string | null;
  federation: string | null;
  games: number;
  last_played: EpochMs | null;
  last_rating: number | null;
  max_rating: number | null;
}

const PLAYER_COLUMNS = 'id, fide_id, database_id, name_key, name, title, federation, games, last_played, last_rating, max_rating';

/** True for names that identify nobody ("?", empty). */
const isAnonymous = (name: string): boolean => !/[\p{L}\p{N}]/u.test(name);

/**
 * Counts one newly stored game for a player (call inside the import transaction): creates the row or
 * bumps `games`, keeps the highest rating, and takes name, title, federation and rating from the
 * most recent game.
 */
export function indexReferencePlayer(db: Db, databaseId: Id, p: IndexedPlayer, playedAt: EpochMs | null): void {
  const name = p.name.trim();
  if (isAnonymous(name)) return;
  const key = playerKey(name);
  const now = Date.now();
  const row = p.fideId
    ? db.get<PlayerRow>(`SELECT ${PLAYER_COLUMNS} FROM reference_players WHERE fide_id = ?`, [p.fideId])
    : db.get<PlayerRow>(`SELECT ${PLAYER_COLUMNS} FROM reference_players WHERE fide_id IS NULL AND database_id = ? AND name_key = ?`, [
        databaseId,
        key,
      ]);
  if (!row) {
    db.run(
      `INSERT INTO reference_players (fide_id, database_id, name_key, name, search_name, title, federation, games,
         last_played, last_rating, max_rating, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      [p.fideId, p.fideId ? null : databaseId, key, name, foldName(name), p.title, p.federation, playedAt, p.rating, p.rating, now],
    );
    return;
  }
  const newer = playedAt !== null && (row.last_played === null || playedAt >= row.last_played);
  const maxRating = p.rating !== null && (row.max_rating === null || p.rating > row.max_rating) ? p.rating : row.max_rating;
  // FIDE rows follow the player's latest spelling; name-keyed rows keep their key.
  const nextName = newer && p.fideId ? name : row.name;
  db.run(
    `UPDATE reference_players
        SET games = games + 1, name = ?, name_key = ?, search_name = ?, title = ?, federation = ?,
            last_played = ?, last_rating = ?, max_rating = ?, updated_at = ?
      WHERE id = ?`,
    [
      nextName,
      p.fideId ? playerKey(nextName) : row.name_key,
      foldName(nextName),
      newer ? (p.title ?? row.title) : (row.title ?? p.title),
      newer ? (p.federation ?? row.federation) : (row.federation ?? p.federation),
      newer ? playedAt : row.last_played,
      newer ? (p.rating ?? row.last_rating) : (row.last_rating ?? p.rating),
      maxRating,
      now,
      row.id,
    ],
  );
}

/** Records federations seen elsewhere (live round previews) for players already in the index. */
export function updateFederations(db: Db, feds: ReadonlyMap<string, string>): number {
  if (feds.size === 0) return 0;
  return db.tx(() => {
    let n = 0;
    for (const [fideId, fed] of feds) {
      n += db.run(
        'UPDATE reference_players SET federation = ?, updated_at = ? WHERE fide_id = ? AND federation IS NOT ?',
        [fed, Date.now(), fideId, fed],
      ).changes;
    }
    return n;
  });
}

/** A visible local profile with this reference player as a source (FIDE id, or pgn name in its database). */
function profileSlugFor(db: Db, row: PlayerRow, viewer: AuthUser | null): string | null {
  const [kind, key] = row.fide_id ? ['fide', row.fide_id] : ['pgn', pgnSourceKey(row.database_id!, row.name)];
  const viewerId = viewer?.id ?? -1;
  const isAdmin = viewer?.role === 'admin';
  return (
    db.value<string>(
      `SELECT p.slug FROM sources s
         JOIN profile_sources ps ON ps.source_id = s.id
         JOIN profiles p ON p.id = ps.profile_id
        WHERE s.kind = ? AND s.key = ?
          AND (p.visibility = 'public' OR p.owner_user_id = ? OR ?)
          AND (ps.hidden = 0 OR p.owner_user_id = ? OR ?)
        ORDER BY (p.owner_user_id = ?) DESC, (p.visibility = 'public') DESC, p.views DESC, p.id
        LIMIT 1`,
      [kind, key, viewerId, isAdmin, viewerId, isAdmin, viewerId],
    ) ?? null
  );
}

function toReferencePlayer(db: Db, row: PlayerRow, viewer: AuthUser | null): ReferencePlayer {
  return {
    fideId: row.fide_id,
    name: row.name,
    title: isTitle(row.title) ? row.title : null,
    federation: row.federation,
    games: row.games,
    lastPlayed: row.last_played,
    maxRating: row.max_rating,
    lastRating: row.last_rating,
    databaseId: row.fide_id ? null : row.database_id,
    profileSlug: profileSlugFor(db, row, viewer),
  };
}

/**
 * Reference-DB players matching a name or FIDE id prefix, best matches first (exact FIDE id, then
 * names starting with the query, then most games). An empty query lists the players with the most
 * games. `viewer` decides which profiles count for `profileSlug` (anonymous: public ones only).
 */
export function searchReferencePlayers(
  db: Db,
  q: string,
  opts: { limit?: number; viewer?: AuthUser | null } = {},
): ReferencePlayer[] {
  const limit = Math.max(1, Math.min(PLAYER_SEARCH_MAX_LIMIT, Math.floor(opts.limit ?? PLAYER_SEARCH_DEFAULT_LIMIT)));
  const viewer = opts.viewer ?? null;
  const query = q.trim().slice(0, PLAYER_SEARCH_MAX_QUERY);
  let rows: PlayerRow[];
  if (query === '') {
    rows = db.all<PlayerRow>(`SELECT ${PLAYER_COLUMNS} FROM reference_players WHERE games > 0 ORDER BY games DESC, id LIMIT ?`, [limit]);
  } else if (/^\d{1,12}$/.test(query)) {
    rows = db.all<PlayerRow>(
      `SELECT ${PLAYER_COLUMNS} FROM reference_players
        WHERE fide_id GLOB ? AND games > 0
        ORDER BY (fide_id = ?) DESC, games DESC, id LIMIT ?`,
      [`${query}*`, query, limit],
    );
  } else {
    const folded = foldName(query);
    const tokens = [...new Set(folded.split(' ').filter(Boolean))].slice(0, MAX_TOKENS);
    if (tokens.length === 0) return [];
    const where = tokens.map(() => `instr(' ' || search_name, ?) > 0`).join(' AND ');
    rows = db.all<PlayerRow>(
      `SELECT ${PLAYER_COLUMNS} FROM reference_players
        WHERE games > 0 AND ${where}
        ORDER BY (search_name = ?) DESC, (substr(search_name, 1, ?) = ?) DESC, games DESC, id
        LIMIT ?`,
      [...tokens.map(t => ` ${t}`), folded, folded.length, folded, limit],
    );
  }
  return rows.map(r => toReferencePlayer(db, r, viewer));
}

/** The index row of a FIDE id (for FIDE profile headers and `fide` source syncs), or null. */
export function referencePlayerByFideId(db: Db, fideId: string, viewer: AuthUser | null = null): ReferencePlayer | null {
  const row = db.get<PlayerRow>(`SELECT ${PLAYER_COLUMNS} FROM reference_players WHERE fide_id = ?`, [fideId]);
  return row ? toReferencePlayer(db, row, viewer) : null;
}
