/**
 * Reference databases (`databases.kind = 'reference'`): the built-in "Lichess broadcasts" database,
 * databases the admin creates by importing a PGN, their `DatabaseInfo` and attribution — PLAN §0.5,
 * §5 (Ultra/Masters DB), §6 `GET /api/reference`.
 */
import type { DatabaseInfo, Id } from '@outpost/shared/api';
import type { Db } from '../db/index.ts';
import { badRequest, notFound } from '../http/errors.ts';
import { JOB_COLUMNS, toJobInfo, type JobRow } from '../jobs/index.ts';

/** `reference_databases.builtin` of the built-in broadcast database. */
export const BROADCAST_BUILTIN = 'lichess-broadcasts';

/** Name, source label and licence of the built-in database (created on first broadcast import). */
export const BROADCAST_DATABASE = {
  name: 'Lichess broadcasts',
  sourceLabel: 'Lichess broadcasts (database.lichess.org)',
  licence: 'CC BY-SA 4.0',
} as const;

/** Attribution line for Lichess broadcast data (CC BY-SA 4.0 requires it wherever the data appears). */
export const LICHESS_BROADCAST_ATTRIBUTION =
  'Broadcast games from the Lichess broadcast database (https://database.lichess.org/#broadcasts) by lichess.org, ' +
  'licensed under CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/). ' +
  'Anything derived from them must be shared under the same licence.';

/** Longest database name / label / licence accepted from the admin. */
export const MAX_NAME_LENGTH = 120;
export const MAX_LICENCE_LENGTH = 500;

interface DatabaseRow {
  id: Id;
  name: string;
  kind: 'games' | 'reference';
  visibility: 'private' | 'public';
  owner_user_id: Id | null;
  owner_username: string | null;
  source_label: string | null;
  licence: string | null;
  created_at: number;
  game_count: number;
  builtin: string | null;
}

const DATABASE_SELECT = `SELECT d.id, d.name, d.kind, d.visibility, d.owner_user_id, u.username AS owner_username,
    d.source_label, d.licence, d.created_at, d.game_count, r.builtin
  FROM databases d
  LEFT JOIN users u ON u.id = d.owner_user_id
  LEFT JOIN reference_databases r ON r.database_id = d.id`;

/** Id of the built-in "Lichess broadcasts" database, or null before the first broadcast import. */
export function broadcastDatabaseId(db: Db): Id | null {
  return (
    db.value<Id>(
      `SELECT r.database_id FROM reference_databases r JOIN databases d ON d.id = r.database_id
        WHERE r.builtin = ? AND d.kind = 'reference'`,
      [BROADCAST_BUILTIN],
    ) ?? null
  );
}

/** The built-in "Lichess broadcasts" database, created (public, CC BY-SA 4.0) when missing. */
export function ensureBroadcastDatabase(db: Db): Id {
  return db.tx(() => {
    const existing = broadcastDatabaseId(db);
    if (existing !== null) return existing;
    const now = Date.now();
    const id = db.run(
      `INSERT INTO databases (owner_user_id, name, kind, visibility, source_label, licence, created_at, game_count)
       VALUES (NULL, ?, 'reference', 'public', ?, ?, ?, 0)`,
      [BROADCAST_DATABASE.name, BROADCAST_DATABASE.sourceLabel, BROADCAST_DATABASE.licence, now],
    ).lastInsertRowid;
    db.run(
      `INSERT INTO reference_databases (database_id, builtin, created_at) VALUES (?, ?, ?)
       ON CONFLICT (builtin) DO UPDATE SET database_id = excluded.database_id, created_at = excluded.created_at`,
      [id, BROADCAST_BUILTIN, now],
    );
    return id;
  });
}

/** Throws 404 unless `id` is a reference database; returns its name. */
export function requireReferenceDatabase(db: Db, id: Id): { id: Id; name: string } {
  const row = db.get<{ id: Id; name: string; kind: string }>('SELECT id, name, kind FROM databases WHERE id = ?', [id]);
  if (!row) throw notFound('Reference database not found');
  if (row.kind !== 'reference') throw badRequest(`Database ${id} is not a reference database`);
  return { id: row.id, name: row.name };
}

/**
 * Finds a reference database by name (case-insensitive) or creates it (instance-wide: no owner,
 * public). `sourceLabel` / `licence` are set on creation and update an existing database when given.
 */
export function findOrCreateReferenceDatabase(
  db: Db,
  opts: { name: string; sourceLabel?: string | null; licence?: string | null },
): Id {
  const name = opts.name.trim();
  if (!name) throw badRequest('databaseName must not be empty');
  return db.tx(() => {
    const existing = db.value<Id>(
      "SELECT id FROM databases WHERE kind = 'reference' AND name = ? COLLATE NOCASE ORDER BY id LIMIT 1",
      [name],
    );
    if (existing !== undefined) {
      updateReferenceDatabaseLabels(db, existing, opts);
      return existing;
    }
    const now = Date.now();
    const id = db.run(
      `INSERT INTO databases (owner_user_id, name, kind, visibility, source_label, licence, created_at, game_count)
       VALUES (NULL, ?, 'reference', 'public', ?, ?, ?, 0)`,
      [name, opts.sourceLabel?.trim() || null, opts.licence?.trim() || null, now],
    ).lastInsertRowid;
    db.run('INSERT INTO reference_databases (database_id, builtin, created_at) VALUES (?, NULL, ?)', [id, now]);
    return id;
  });
}

/** Sets `source_label` / `licence` of a reference database when non-empty values are given. */
export function updateReferenceDatabaseLabels(
  db: Db,
  id: Id,
  opts: { sourceLabel?: string | null; licence?: string | null },
): void {
  const label = opts.sourceLabel?.trim();
  const licence = opts.licence?.trim();
  if (label) db.run('UPDATE databases SET source_label = ? WHERE id = ?', [label, id]);
  if (licence) db.run('UPDATE databases SET licence = ? WHERE id = ?', [licence, id]);
}

/**
 * Marks a database as holding Lichess broadcast data: a missing licence / source label becomes the
 * broadcast one, so the CC BY-SA attribution travels with the games.
 */
export function markBroadcastData(db: Db, id: Id): void {
  db.run('UPDATE databases SET licence = COALESCE(licence, ?), source_label = COALESCE(source_label, ?) WHERE id = ?', [
    BROADCAST_DATABASE.licence,
    BROADCAST_DATABASE.sourceLabel,
    id,
  ]);
}

/** Recounts `databases.game_count` from the stored games. */
export function recountDatabaseGames(db: Db, id: Id): number {
  const n = db.value<number>('SELECT COUNT(*) FROM games WHERE database_id = ?', [id]) ?? 0;
  db.run('UPDATE databases SET game_count = ? WHERE id = ?', [n, id]);
  return n;
}

/** The latest import job of a reference database while queued/running, or when it failed. */
function latestImportJob(db: Db, databaseId: Id): DatabaseInfo['importJob'] {
  const kinds = "kind IN ('referenceImport', 'broadcastMonth', 'broadcastRound') AND json_extract(payload_json, '$.databaseId') = ?";
  const active = db.get<JobRow>(
    `SELECT ${JOB_COLUMNS} FROM jobs WHERE status IN ('running', 'queued') AND ${kinds}
      ORDER BY status = 'running' DESC, priority DESC, created_at, id LIMIT 1`,
    [databaseId],
  );
  const row = active ?? db.get<JobRow>(`SELECT ${JOB_COLUMNS} FROM jobs WHERE ${kinds} ORDER BY id DESC LIMIT 1`, [databaseId]);
  return row && (row === active || row.status === 'error') ? toJobInfo(db, row) : null;
}

function toDatabaseInfo(db: Db, r: DatabaseRow, isAdmin: boolean): DatabaseInfo {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    visibility: r.visibility,
    owner: r.owner_user_id !== null && r.owner_username !== null ? { id: r.owner_user_id, username: r.owner_username } : null,
    sourceLabel: r.source_label,
    licence: r.licence,
    createdAt: r.created_at,
    gameCount: r.game_count,
    canEdit: isAdmin,
    // Jobs name the admin who queued them and carry error text: admins only.
    importJob: isAdmin ? latestImportJob(db, r.id) : null,
    builtin: r.builtin === BROADCAST_BUILTIN,
  };
}

/**
 * SQL condition (on `databases d`) for the reference databases a viewer may see: every one for
 * admins, public ones for everybody else (an admin can make one private, e.g. licensed data).
 */
export const visibleReferenceDbSql = (isAdmin: boolean): string => (isAdmin ? '1' : "d.visibility = 'public'");

/** Every reference database the viewer may see (the built-in one first), as `DatabaseInfo`. Admins may edit them. */
export function listReferenceDatabases(db: Db, opts: { isAdmin: boolean }): DatabaseInfo[] {
  return db
    .all<DatabaseRow>(
      `${DATABASE_SELECT} WHERE d.kind = 'reference' AND ${visibleReferenceDbSql(opts.isAdmin)}
        ORDER BY (r.builtin IS NULL), d.name COLLATE NOCASE, d.id`,
    )
    .map(r => toDatabaseInfo(db, r, opts.isAdmin));
}

/** Whether a database holds (or is meant for) Lichess broadcast data. */
function hasBroadcastData(db: Db, id: Id, builtin: string | null): boolean {
  if (builtin === BROADCAST_BUILTIN) return true;
  return (
    db.get('SELECT 1 FROM reference_broadcast_months WHERE database_id = ? LIMIT 1', [id]) !== undefined ||
    db.get('SELECT 1 FROM reference_broadcast_rounds WHERE database_id = ? LIMIT 1', [id]) !== undefined ||
    db.get('SELECT 1 FROM reference_broadcast_games WHERE database_id = ? LIMIT 1', [id]) !== undefined
  );
}

/**
 * Attribution lines to show wherever reference data appears: the CC BY-SA line for Lichess
 * broadcast data, plus `<name> (<source>): <licence>` for every other database that names a
 * licence — of the databases the viewer may see (all of them by default).
 */
export function referenceAttribution(db: Db, opts: { isAdmin: boolean } = { isAdmin: true }): string[] {
  const lines: string[] = [];
  let broadcast = false;
  for (const r of db.all<DatabaseRow>(
    `${DATABASE_SELECT} WHERE d.kind = 'reference' AND ${visibleReferenceDbSql(opts.isAdmin)} ORDER BY d.id`,
  )) {
    const isBroadcast = hasBroadcastData(db, r.id, r.builtin);
    broadcast ||= isBroadcast;
    // Broadcast data under its own licence is covered by the Lichess line.
    if (!r.licence || (isBroadcast && r.licence === BROADCAST_DATABASE.licence)) continue;
    const source = r.source_label && r.source_label !== r.name ? ` (${r.source_label})` : '';
    lines.push(`${r.name}${source}: ${r.licence}`);
  }
  if (broadcast) lines.unshift(LICHESS_BROADCAST_ATTRIBUTION);
  return [...new Set(lines)];
}
