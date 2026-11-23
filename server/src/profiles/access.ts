/**
 * Per-object read access (PLAN §10 "Access") for profiles and databases, shared by every module
 * that reads them: stats and games (stats), the player explorer and games-at-position (explorer),
 * prep, databases and profiles (profiles). Owner: profiles.
 *
 * The route's preHandler (`requireViewer` / `requireUser`) has already decided whether an
 * anonymous visitor may read anything at all; these functions check the object itself and throw
 * 404 `not_found` for objects the viewer may not see (so private ones don't leak their existence).
 *
 *   app.get(API_ROUTES.stats.games(':slug'), { preHandler: requireViewer }, async req => {
 *     const profile = loadProfileForViewer(app.db, slug, req.user);
 *     const where = playerGamesWhere(parseFiltersQuery(req.query), { sourceIds: profile.sourceIds });
 *     …
 *
 * **The one database rule** (`canReadDatabase`, `READABLE_DATABASE_SQL`), applied by every path
 * that reaches a database's games — the database pages, `db:<id>` explorers, `/api/games/:id`,
 * masters `op<id>` PGNs, `pgn` sources of profiles, the reference explorer:
 * - admins read every database;
 * - a `games` database: its owner, and every **signed-in** user while it is public (database
 *   reads need a session even with anonymous browsing on, decision 6);
 * - a `reference` database: every viewer while it is public (instance-wide data, decision 2;
 *   anonymous visitors too when anonymous browsing is on); a private one is admins only.
 */
import type { DatabaseKind, Id, Visibility } from '@outpost/shared/api';
import type { Db } from '../db/index.ts';
import { notFound } from '../http/errors.ts';
import type { AuthUser } from '../http/types.ts';

/** What read access to a database depends on (a `databases` row). */
export interface DatabaseAccessRow {
  kind: DatabaseKind;
  visibility: Visibility;
  owner_user_id: Id | null;
}

/** May `viewer` (null = anonymous) read the games of this database? See the module comment. */
export function canReadDatabase(row: DatabaseAccessRow, viewer: AuthUser | null): boolean {
  if (viewer?.role === 'admin') return true;
  if (row.visibility === 'public') return row.kind === 'reference' || viewer !== null;
  return row.kind === 'games' && viewer !== null && viewer.id === row.owner_user_id;
}

/**
 * `canReadDatabase` as SQL over a `databases` row aliased `d`, with the named parameters `:me`
 * (viewer id or null) and `:admin` (boolean): bind them with `readerParams(viewer)`.
 */
export const READABLE_DATABASE_SQL = `(:admin
  OR (d.visibility = 'public' AND (d.kind = 'reference' OR :me IS NOT NULL))
  OR (d.kind = 'games' AND d.owner_user_id = :me))`;

/** The `:me` / `:admin` parameters of `READABLE_DATABASE_SQL`. */
export const readerParams = (viewer: AuthUser | null): { me: Id | null; admin: boolean } => ({
  me: viewer?.id ?? null,
  admin: viewer?.role === 'admin',
});

/** Ids of the reference databases `viewer` may read (oldest first). */
export function readableReferenceDatabaseIds(db: Db, viewer: AuthUser | null): Id[] {
  return db
    .all<{ id: Id }>(`SELECT d.id FROM databases d WHERE d.kind = 'reference' AND ${READABLE_DATABASE_SQL} ORDER BY d.id`, readerParams(viewer))
    .map(r => r.id);
}

/** A profile the viewer may read. */
export interface ViewableProfile {
  id: Id;
  slug: string;
  displayName: string;
  ownerUserId: Id | null;
  visibility: Visibility;
  autoRefresh: boolean;
  /** Owner or admin: may edit, update, delete, and sees hidden sources. */
  canEdit: boolean;
  /**
   * Source ids the viewer may see (hidden ones only when `canEdit`; `pgn` sources only when the
   * viewer may read their database, `canReadDatabase`). Pass these to `playerGamesWhere`.
   */
  sourceIds: Id[];
}

/**
 * Loads a profile by slug for `viewer` (null = anonymous). Private profiles are visible to their
 * owner and admins only; public ones to every viewer. Throws 404 otherwise.
 * Use `loadProfileByIdForViewer` when you hold an id (prep, bookmarks).
 */
export function loadProfileForViewer(db: Db, slug: string, viewer: AuthUser | null): ViewableProfile {
  const row = db.get<{
    id: Id;
    slug: string;
    display_name: string;
    owner_user_id: Id | null;
    visibility: Visibility;
    auto_refresh: number;
  }>('SELECT id, slug, display_name, owner_user_id, visibility, auto_refresh FROM profiles WHERE slug = ?', [slug]);
  if (!row) throw notFound('Profile not found');
  const isAdmin = viewer?.role === 'admin';
  const canEdit = viewer !== null && (isAdmin || viewer.id === row.owner_user_id);
  if (row.visibility === 'private' && !canEdit) throw notFound('Profile not found');
  // A `pgn` source reads a database: its games count only while the viewer may read that database
  // (a public profile must not expose a private PGN collection of someone else; decision 6).
  const sourceIds = db
    .all<{ source_id: Id }>(
      `SELECT ps.source_id
         FROM profile_sources ps
         JOIN sources s ON s.id = ps.source_id
         LEFT JOIN databases d ON d.id = s.database_id
        WHERE ps.profile_id = :profile AND (ps.hidden = 0 OR :canEdit)
          AND (s.database_id IS NULL OR ${READABLE_DATABASE_SQL})
        ORDER BY ps.source_id`,
      { profile: row.id, canEdit, ...readerParams(viewer) },
    )
    .map(r => r.source_id);
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.display_name,
    ownerUserId: row.owner_user_id,
    visibility: row.visibility,
    autoRefresh: row.auto_refresh === 1,
    canEdit,
    sourceIds,
  };
}

/** A database the viewer may read. */
export interface ViewableDatabase {
  id: Id;
  name: string;
  kind: DatabaseKind;
  ownerUserId: Id | null;
  visibility: Visibility;
  /** `games`: owner or admin; `reference`: admin. */
  canEdit: boolean;
}

/**
 * Loads a database for `viewer` under the one database rule (module comment: reference databases
 * for every viewer unless private, `games` databases for their owner, or for signed-in users while
 * public; admins read all). Throws 404 otherwise.
 */
export function loadDatabaseForViewer(db: Db, id: Id, viewer: AuthUser | null): ViewableDatabase {
  const row = db.get<{ id: Id; name: string; kind: DatabaseKind; owner_user_id: Id | null; visibility: Visibility }>(
    'SELECT id, name, kind, owner_user_id, visibility FROM databases WHERE id = ?',
    [id],
  );
  if (!row || !canReadDatabase(row, viewer)) throw notFound('Database not found');
  const isAdmin = viewer?.role === 'admin';
  const canEdit = row.kind === 'reference' ? isAdmin : isAdmin || (viewer !== null && viewer.id === row.owner_user_id);
  return { id: row.id, name: row.name, kind: row.kind, ownerUserId: row.owner_user_id, visibility: row.visibility, canEdit };
}

/** `loadProfileForViewer` by profile id (same rules, same 404). */
export function loadProfileByIdForViewer(db: Db, id: Id, viewer: AuthUser | null): ViewableProfile {
  const slug = db.value<string>('SELECT slug FROM profiles WHERE id = ?', [id]);
  if (slug === undefined) throw notFound('Profile not found');
  return loadProfileForViewer(db, slug, viewer);
}
