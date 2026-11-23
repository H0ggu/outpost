/**
 * The reference player index (`reference_players`, migration 600): one row per FIDE id across all
 * reference databases, and one per (database, name) for players without a FIDE id. Maintained by the
 * importer for every newly stored game; game deletions are counted down by a trigger.
 *
 * Search (`GET /api/reference/players`, unified search) matches FIDE id prefixes, or every word of
 * the query against the start of a word of the folded name, so "magnus carlsen", "carlsen" and
 * "Carlsen, M" all find "Carlsen, Magnus".
 *
 * A FIDE player's federation also becomes their country in `players_cache` (kind `fide`, key the
 * FIDE id), where the world map, the opponents list and game rows look opponents up.
 */
import type { EpochMs, Id, ReferencePlayer, Title } from '@outpost/shared/api';
import { isTitle, playerKey } from '@outpost/shared/chess';
import { pgnSourceKey } from '../chess/index.ts';
import type { Db } from '../db/index.ts';
import type { AuthUser } from '../http/types.ts';
import { visibleReferenceDbSql } from './databases.ts';
import { federationCountry } from './federations.ts';

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

/** Replaces the search words of a player (`reference_player_words`) with those of `searchName`. */
function setPlayerWords(db: Db, playerId: Id, searchName: string, replace: boolean): void {
  if (replace) db.run('DELETE FROM reference_player_words WHERE player_id = ?', [playerId]);
  for (const word of new Set(searchName.split(' ').filter(Boolean))) {
    db.run('INSERT OR IGNORE INTO reference_player_words (word, player_id) VALUES (?, ?)', [word, playerId]);
  }
}

/**
 * Stores a FIDE player's country (from their federation) in `players_cache`, where the stats look
 * opponents up (`opp_source_kind = 'fide'`, `opp_key` = FIDE id). A known country is never replaced
 * by an unknown one.
 */
export function cacheFideCountry(db: Db, fideId: string, federation: string | null, info: { title: string | null; name: string | null }): void {
  const country = federationCountry(federation);
  if (!country) return;
  db.run(
    `INSERT INTO players_cache (kind, key, country, title, name, fetched_at) VALUES ('fide', ?, ?, ?, ?, ?)
     ON CONFLICT (kind, key) DO UPDATE SET country = excluded.country, title = COALESCE(excluded.title, players_cache.title),
       name = COALESCE(excluded.name, players_cache.name), fetched_at = excluded.fetched_at
     WHERE players_cache.country IS NOT excluded.country OR players_cache.title IS NOT COALESCE(excluded.title, players_cache.title)`,
    [fideId, country, isTitle(info.title) ? info.title : null, info.name, Date.now()],
  );
}

/**
 * Copies the countries of every indexed FIDE player with a federation into `players_cache` (those
 * missing there, or with another country), and gives FIDE sources without a country theirs (the FIDE
 * directory's federation kept in `profile_json`, else the index's). Idempotent; run at startup, so
 * federations known before countries were derived from them count too. Returns the rows written.
 */
export function backfillFideCountries(db: Db): number {
  return backfillFidePlayers(db) + backfillFideSources(db);
}

function backfillFideSources(db: Db): number {
  const sources = db.all<{ id: Id; key: string; federation: string | null; cached: string | null }>(
    `SELECT s.id, s.key, json_extract(s.profile_json, '$.federation') AS federation, pc.country AS cached
       FROM sources s LEFT JOIN players_cache pc ON pc.kind = 'fide' AND pc.key = s.key
      WHERE s.kind = 'fide' AND s.country IS NULL AND json_valid(coalesce(s.profile_json, 'null'))`,
  );
  let n = 0;
  for (const s of sources) {
    const country = federationCountry(typeof s.federation === 'string' ? s.federation : null) ?? s.cached;
    if (country) n += db.run('UPDATE sources SET country = ? WHERE id = ? AND country IS NULL', [country, s.id]).changes;
  }
  return n;
}

function backfillFidePlayers(db: Db): number {
  const rows = db.all<{ fide_id: string; federation: string; title: string | null; name: string; cached: string | null }>(
    `SELECT rp.fide_id, rp.federation, rp.title, rp.name, pc.country AS cached
       FROM reference_players rp
       LEFT JOIN players_cache pc ON pc.kind = 'fide' AND pc.key = rp.fide_id
      WHERE rp.fide_id IS NOT NULL AND rp.federation IS NOT NULL`,
  );
  const todo = rows.filter(r => federationCountry(r.federation) !== null && federationCountry(r.federation) !== r.cached);
  if (todo.length === 0) return 0;
  return db.tx(() => {
    for (const r of todo) cacheFideCountry(db, r.fide_id, r.federation, { title: r.title, name: r.name });
    return todo.length;
  });
}

/** Upper bound of a prefix range: every string starting with `prefix` sorts below it (BINARY collation). */
const prefixEnd = (prefix: string): string => `${prefix}\u{10FFFF}`;

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
    const searchName = foldName(name);
    const { lastInsertRowid } = db.run(
      `INSERT INTO reference_players (fide_id, database_id, name_key, name, search_name, title, federation, games,
         last_played, last_rating, max_rating, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      [p.fideId, p.fideId ? null : databaseId, key, name, searchName, p.title, p.federation, playedAt, p.rating, p.rating, now],
    );
    setPlayerWords(db, lastInsertRowid, searchName, false);
    if (p.fideId && p.federation) cacheFideCountry(db, p.fideId, p.federation, { title: p.title, name });
    return;
  }
  const newer = playedAt !== null && (row.last_played === null || playedAt >= row.last_played);
  const maxRating = p.rating !== null && (row.max_rating === null || p.rating > row.max_rating) ? p.rating : row.max_rating;
  // FIDE rows follow the player's latest spelling; name-keyed rows keep their key.
  const nextName = newer && p.fideId ? name : row.name;
  if (nextName !== row.name) setPlayerWords(db, row.id, foldName(nextName), true);
  const federation = newer ? (p.federation ?? row.federation) : (row.federation ?? p.federation);
  const title = newer ? (p.title ?? row.title) : (row.title ?? p.title);
  db.run(
    `UPDATE reference_players
        SET games = games + 1, name = ?, name_key = ?, search_name = ?, title = ?, federation = ?,
            last_played = ?, last_rating = ?, max_rating = ?, updated_at = ?
      WHERE id = ?`,
    [
      nextName,
      p.fideId ? playerKey(nextName) : row.name_key,
      foldName(nextName),
      title,
      federation,
      newer ? playedAt : row.last_played,
      newer ? (p.rating ?? row.last_rating) : (row.last_rating ?? p.rating),
      maxRating,
      now,
      row.id,
    ],
  );
  if (p.fideId && federation && (federation !== row.federation || title !== row.title))
    cacheFideCountry(db, p.fideId, federation, { title, name: nextName });
}

/** Records federations seen elsewhere (live round previews) for players already in the index. */
export function updateFederations(db: Db, feds: ReadonlyMap<string, string>): number {
  if (feds.size === 0) return 0;
  return db.tx(() => {
    let n = 0;
    for (const [fideId, fed] of feds) {
      const changed = db.run(
        'UPDATE reference_players SET federation = ?, updated_at = ? WHERE fide_id = ? AND federation IS NOT ?',
        [fed, Date.now(), fideId, fed],
      ).changes;
      if (changed) {
        const row = db.get<{ title: string | null; name: string }>('SELECT title, name FROM reference_players WHERE fide_id = ?', [fideId]);
        cacheFideCountry(db, fideId, fed, { title: row?.title ?? null, name: row?.name ?? null });
      }
      n += changed;
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
 * SQL condition (` AND …`, on `reference_players`) for the players a non-admin may find.
 * Name-only players belong to one database: hidden with it when it is private. FIDE players
 * aggregate the reference databases but are built from public ones only (migration 602): hidden
 * when none of their games is in a public database. That check only runs while some reference
 * database is private (the usual instance has none).
 */
function visiblePlayersSql(db: Db): string {
  if (db.value("SELECT 1 FROM databases WHERE kind = 'reference' AND visibility <> 'public' LIMIT 1") === undefined) return '';
  const visibleDbs = `SELECT d.id FROM databases d WHERE d.kind = 'reference' AND ${visibleReferenceDbSql(false)}`;
  return ` AND (database_id IN (${visibleDbs})
    OR (fide_id IS NOT NULL
        AND (EXISTS (SELECT 1 FROM games g WHERE g.white_fide_id = reference_players.fide_id AND g.database_id IN (${visibleDbs}))
          OR EXISTS (SELECT 1 FROM games g WHERE g.black_fide_id = reference_players.fide_id AND g.database_id IN (${visibleDbs})))))`;
}

/**
 * Reference-DB players matching a name or FIDE id prefix, best matches first (exact FIDE id, then
 * names starting with the query, then most games). An empty query lists the players with the most
 * games. `viewer` decides which profiles count for `profileSlug` (anonymous: public ones only) and
 * whether players of private reference databases show (admins only); pass it from routes
 * (`viewer: req.user`). FIDE players show to non-admins when a public database has their games.
 */
export function searchReferencePlayers(
  db: Db,
  q: string,
  opts: { limit?: number; viewer?: AuthUser | null } = {},
): ReferencePlayer[] {
  const limit = Math.max(1, Math.min(PLAYER_SEARCH_MAX_LIMIT, Math.floor(opts.limit ?? PLAYER_SEARCH_DEFAULT_LIMIT)));
  const viewer = opts.viewer ?? null;
  const query = q.trim().slice(0, PLAYER_SEARCH_MAX_QUERY);
  const visible = viewer?.role === 'admin' ? '' : visiblePlayersSql(db);
  let rows: PlayerRow[];
  if (query === '') {
    rows = db.all<PlayerRow>(`SELECT ${PLAYER_COLUMNS} FROM reference_players WHERE games > 0${visible} ORDER BY games DESC, id LIMIT ?`, [
      limit,
    ]);
  } else if (/^\d{1,12}$/.test(query)) {
    rows = db.all<PlayerRow>(
      `SELECT ${PLAYER_COLUMNS} FROM reference_players
        WHERE fide_id GLOB ? AND games > 0${visible}
        ORDER BY (fide_id = ?) DESC, games DESC, id LIMIT ?`,
      [`${query}*`, query, limit],
    );
  } else {
    const folded = foldName(query);
    const tokens = [...new Set(folded.split(' ').filter(Boolean))].slice(0, MAX_TOKENS);
    if (tokens.length === 0) return [];
    // Candidates come from the word index (the longest token is the most selective prefix); every
    // token must then start a word of the name.
    const anchor = tokens.reduce((a, b) => (b.length > a.length ? b : a));
    const where = tokens.map(() => `instr(' ' || search_name, ?) > 0`).join(' AND ');
    rows = db.all<PlayerRow>(
      `SELECT ${PLAYER_COLUMNS} FROM reference_players
        WHERE id IN (SELECT player_id FROM reference_player_words WHERE word >= ? AND word < ?)
          AND games > 0 AND ${where}${visible}
        ORDER BY (search_name = ?) DESC, (substr(search_name, 1, ?) = ?) DESC, games DESC, id
        LIMIT ?`,
      [anchor, prefixEnd(anchor), ...tokens.map(t => ` ${t}`), folded, folded.length, folded, limit],
    );
  }
  return rows.map(r => toReferencePlayer(db, r, viewer));
}

/** The index row of a FIDE id (for FIDE profile headers and `fide` source syncs), or null. */
export function referencePlayerByFideId(db: Db, fideId: string, viewer: AuthUser | null = null): ReferencePlayer | null {
  const row = db.get<PlayerRow>(`SELECT ${PLAYER_COLUMNS} FROM reference_players WHERE fide_id = ?`, [fideId]);
  return row ? toReferencePlayer(db, row, viewer) : null;
}
