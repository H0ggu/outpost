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
 */
import type { DatabaseKind, Id, Visibility } from '@outpost/shared/api';
import type { Db } from '../db/index.ts';
import { notFound } from '../http/errors.ts';
import type { AuthUser } from '../http/types.ts';

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
   * viewer may read their database). Pass these to `playerGamesWhere`.
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
  // (a public profile must not expose a private PGN collection of someone else).
  const sourceIds = db
    .all<{ source_id: Id }>(
      `SELECT ps.source_id
         FROM profile_sources ps
         JOIN sources s ON s.id = ps.source_id
         LEFT JOIN databases d ON d.id = s.database_id
        WHERE ps.profile_id = ? AND (ps.hidden = 0 OR ?)
          AND (s.database_id IS NULL OR d.kind = 'reference' OR d.visibility = 'public' OR ? OR d.owner_user_id = ?)
        ORDER BY ps.source_id`,
      [row.id, canEdit, isAdmin, viewer?.id ?? null],
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
 * Loads a database for `viewer`. Reference databases are instance-wide data and readable by every
 * viewer; a `games` database is readable by its owner and admins, or by every viewer when public.
 * Throws 404 otherwise.
 */
export function loadDatabaseForViewer(db: Db, id: Id, viewer: AuthUser | null): ViewableDatabase {
  const row = db.get<{ id: Id; name: string; kind: DatabaseKind; owner_user_id: Id | null; visibility: Visibility }>(
    'SELECT id, name, kind, owner_user_id, visibility FROM databases WHERE id = ?',
    [id],
  );
  if (!row) throw notFound('Database not found');
  const isAdmin = viewer?.role === 'admin';
  const canEdit = row.kind === 'reference' ? isAdmin : isAdmin || (viewer !== null && viewer.id === row.owner_user_id);
  if (row.kind === 'games' && row.visibility === 'private' && !canEdit) throw notFound('Database not found');
  return { id: row.id, name: row.name, kind: row.kind, ownerUserId: row.owner_user_id, visibility: row.visibility, canEdit };
}

/** `loadProfileForViewer` by profile id (same rules, same 404). */
export function loadProfileByIdForViewer(db: Db, id: Id, viewer: AuthUser | null): ViewableProfile {
  const slug = db.value<string>('SELECT slug FROM profiles WHERE id = ?', [id]);
  if (slug === undefined) throw notFound('Profile not found');
  return loadProfileForViewer(db, slug, viewer);
}
