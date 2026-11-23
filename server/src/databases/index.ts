/**
 * User PGN databases (PLAN §4 `databases`, §5 "Custom PGN databases", §6): CRUD with ownership and
 * visibility, game lists, single-game delete, streamed export, and the import pipeline
 * (`import.ts`). Reference databases are readable here too (instance-wide data); only admins may
 * change them, and their imports go through the reference module.
 *
 * Access: `loadDatabaseForViewer` (src/profiles/access.ts, the one database rule): owner or admin
 * edit a `games` database; other signed-in users see it only while it is public; a reference
 * database is readable by everyone unless an admin made it private (404 otherwise).
 */
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import type {
  CreateDatabaseRequest,
  DatabaseInfo,
  DatabaseKind,
  DbGamesPage,
  EpochMs,
  Id,
  JobInfo,
  UpdateDatabaseRequest,
  Visibility,
} from '@outpost/shared/api';
import { playerKey } from '@outpost/shared/chess';
import { z } from 'zod';
import { relinkFideSources } from '../chess/index.ts';
import type { Config } from '../config.ts';
import type { Db, SqlValue } from '../db/index.ts';
import { forbidden, notFound } from '../http/errors.ts';
import type { AuthUser } from '../http/types.ts';
import { getJob } from '../jobs/index.ts';
import { READABLE_DATABASE_SQL, readerParams, type ViewableDatabase } from '../profiles/access.ts';
import { BROADCAST_BUILTIN } from '../reference/databases.ts';
import { cancelQueuedSyncs } from '../profiles/service.ts';
import { DB_GAME_ROW_COLUMNS, likeContains, toDbGameRow, type DbGameRowRecord } from '../stats/index.ts';
import { dropDatabaseUploads } from './import.ts';
import { gameToPgn, PGN_GAME_COLUMNS, type PgnGameRow } from './pgnWriter.ts';

export {
  checkImportAllowed,
  enqueuePgnImport,
  importSummary,
  MAX_GAMES_PER_USER,
  MAX_PASTE_BYTES,
  MAX_PENDING_IMPORTS,
  MAX_PGN_BYTES,
  runPgnImport,
  saveUploadStream,
  saveUploadText,
  sweepUploads,
  uploadPath,
} from './import.ts';
export { gameToPgn, movetext } from './pgnWriter.ts';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const noControlChars = (s: string): boolean => !/[\u0000-\u001f\u007f]/.test(s);
const text = (max: number) => z.string().trim().min(1).max(max).refine(noControlChars, 'control characters are not allowed');

/** `CreateDatabaseRequest`. */
export const createDatabaseSchema = z.object({
  name: text(100),
  visibility: z.enum(['private', 'public']).optional(),
  sourceLabel: text(200).optional(),
  licence: text(200).optional(),
});

/** `UpdateDatabaseRequest` (`null` clears the label / licence). */
export const updateDatabaseSchema = z.object({
  name: text(100).optional(),
  visibility: z.enum(['private', 'public']).optional(),
  sourceLabel: text(200).nullable().optional(),
  licence: text(200).nullable().optional(),
});

/** `DbGamesQuery` (pageSize 50 by default, at most 200). */
export const dbGamesQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

/** `ImportPgnRequest` (pasted text; uploads use multipart). */
export const importPgnSchema = z.object({ pgn: z.string().min(1, 'paste some PGN') });

/** Most `games` databases one user may own. */
export const MAX_DATABASES_PER_USER = 200;

// ---------------------------------------------------------------------------
// Info
// ---------------------------------------------------------------------------

interface DatabaseRow {
  id: Id;
  name: string;
  kind: DatabaseKind;
  visibility: Visibility;
  owner_user_id: Id | null;
  owner_username: string | null;
  source_label: string | null;
  licence: string | null;
  created_at: EpochMs;
  game_count: number;
}

const DATABASE_COLUMNS = `d.id, d.name, d.kind, d.visibility, d.owner_user_id, u.username AS owner_username, d.source_label,
  d.licence, d.created_at, d.game_count`;

const canEditRow = (row: Pick<DatabaseRow, 'kind' | 'owner_user_id'>, viewer: AuthUser | null): boolean =>
  viewer !== null && (viewer.role === 'admin' || (row.kind === 'games' && viewer.id === row.owner_user_id));

/** The latest import job (shown while queued/running or after a failure) and the latest finished one. */
function importJobs(db: Db, databaseId: Id): { importJob: JobInfo | null; lastImport: JobInfo | null } {
  let importJob: JobInfo | null = null;
  let lastImport: JobInfo | null = null;
  let first = true;
  for (const r of db.all<{ job_id: Id }>('SELECT job_id FROM database_imports WHERE database_id = ? ORDER BY job_id DESC LIMIT 20', [databaseId])) {
    const job = getJob(db, r.job_id);
    if (!job) continue;
    if (first && (job.status === 'queued' || job.status === 'running' || job.status === 'error')) importJob = job;
    first = false;
    if (job.status === 'done') {
      lastImport = job;
      break;
    }
  }
  return { importJob, lastImport };
}

function toInfo(db: Db, row: DatabaseRow, viewer: AuthUser | null): DatabaseInfo {
  const canEdit = canEditRow(row, viewer);
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    visibility: row.visibility,
    owner: row.owner_user_id !== null && row.owner_username !== null ? { id: row.owner_user_id, username: row.owner_username } : null,
    sourceLabel: row.source_label,
    licence: row.licence,
    createdAt: row.created_at,
    gameCount: row.game_count,
    canEdit,
    // Import jobs name the uploader and the uploaded file: editors only.
    ...(canEdit ? importJobs(db, row.id) : { importJob: null, lastImport: null }),
  };
}

/** `GET /api/databases/:id` (after `loadDatabaseForViewer`). */
export function databaseInfo(db: Db, database: ViewableDatabase, viewer: AuthUser | null): DatabaseInfo {
  const row = db.get<DatabaseRow>(`SELECT ${DATABASE_COLUMNS} FROM databases d LEFT JOIN users u ON u.id = d.owner_user_id WHERE d.id = ?`, [
    database.id,
  ]);
  if (!row) throw notFound('Database not found');
  return toInfo(db, row, viewer);
}

/**
 * `GET /api/databases`: my `games` databases first, then the public ones of others, then the
 * reference databases the viewer may read (instance-wide data, decision 2; private ones for admins
 * only), each group by name.
 */
export function listDatabases(db: Db, viewer: AuthUser | null): DatabaseInfo[] {
  const rows = db.all<DatabaseRow & { builtin: string | null }>(
    `SELECT ${DATABASE_COLUMNS}, r.builtin FROM databases d
       LEFT JOIN users u ON u.id = d.owner_user_id
       LEFT JOIN reference_databases r ON r.database_id = d.id
      WHERE (d.kind = 'games' AND (d.visibility = 'public' OR d.owner_user_id = :me))
         OR (d.kind = 'reference' AND ${READABLE_DATABASE_SQL})
      ORDER BY d.kind = 'reference', (d.owner_user_id IS :me) DESC, (r.builtin IS NULL), d.name COLLATE NOCASE, d.id`,
    readerParams(viewer),
  );
  return rows.map(r => ({ ...toInfo(db, r, viewer), ...(r.kind === 'reference' ? { builtin: r.builtin === BROADCAST_BUILTIN } : {}) }));
}

/** 403 unless the viewer may change the database. */
export function requireDatabaseEditor(database: ViewableDatabase): void {
  if (!database.canEdit) throw forbidden('Only the owner or an admin can change this database');
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/** `POST /api/databases`: a private (by default) `games` database owned by the viewer. */
export function createDatabase(db: Db, viewer: AuthUser, body: CreateDatabaseRequest): Id {
  const owned = db.value<number>("SELECT COUNT(*) FROM databases WHERE owner_user_id = ? AND kind = 'games'", [viewer.id]) ?? 0;
  if (owned >= MAX_DATABASES_PER_USER) throw forbidden(`You can own at most ${MAX_DATABASES_PER_USER} databases`);
  return db.run(
    `INSERT INTO databases (owner_user_id, name, kind, visibility, source_label, licence, created_at, game_count)
     VALUES (?, ?, 'games', ?, ?, ?, ?, 0)`,
    [viewer.id, body.name, body.visibility ?? 'private', body.sourceLabel ?? null, body.licence ?? null, Date.now()],
  ).lastInsertRowid;
}

/**
 * `PATCH /api/databases/:id`. A reference database made private becomes admins-only, which also
 * takes it out of every FIDE player (and a public one puts it back): `relinkFideSources`.
 */
export function updateDatabase(db: Db, database: ViewableDatabase, patch: UpdateDatabaseRequest): void {
  requireDatabaseEditor(database);
  const sets: string[] = [];
  const params: Array<string | null> = [];
  for (const [field, column] of [
    ['name', 'name'],
    ['visibility', 'visibility'],
    ['sourceLabel', 'source_label'],
    ['licence', 'licence'],
  ] as const) {
    const v = patch[field];
    if (v === undefined) continue;
    sets.push(`${column} = ?`);
    params.push(v);
  }
  if (sets.length === 0) return;
  db.tx(() => {
    db.run(`UPDATE databases SET ${sets.join(', ')} WHERE id = ?`, [...params, database.id]);
    if (database.kind === 'reference' && patch.visibility !== undefined && patch.visibility !== database.visibility) {
      relinkFideSources(db, database.id);
    }
  });
}

const DELETE_BATCH = 500;

/**
 * `DELETE /api/databases/:id`: its games (with positions and player_games), its `pgn` sources
 * (detached from every profile, their queued syncs cancelled) and its pending uploads. Games go in
 * short batches so the server stays responsive while a large database is removed.
 */
export async function deleteDatabase(db: Db, config: Config, database: ViewableDatabase): Promise<void> {
  requireDatabaseEditor(database);
  await dropDatabaseUploads(db, config, database.id);
  db.tx(() =>
    cancelQueuedSyncs(
      db,
      db.all<{ id: Id }>("SELECT id FROM sources WHERE kind = 'pgn' AND database_id = ?", [database.id]).map(r => r.id),
    ),
  );
  for (;;) {
    const n = db.tx(
      () =>
        db.run('DELETE FROM games WHERE id IN (SELECT id FROM games WHERE database_id = ? LIMIT ?)', [database.id, DELETE_BATCH])
          .changes,
    );
    if (n < DELETE_BATCH) break;
    await yieldToLoop();
  }
  db.run('DELETE FROM databases WHERE id = ?', [database.id]);
}

/** `DELETE /api/databases/:id/games/:gameId`: one game (positions and player_games go with it). */
export function deleteDatabaseGame(db: Db, database: ViewableDatabase, gameId: Id): void {
  requireDatabaseEditor(database);
  db.tx(() => {
    const removed = db.run('DELETE FROM games WHERE id = ? AND database_id = ?', [gameId, database.id]).changes;
    if (removed === 0) throw notFound('Game not found in this database');
    db.run('UPDATE databases SET game_count = MAX(game_count - 1, 0) WHERE id = ?', [database.id]);
  });
}

// ---------------------------------------------------------------------------
// Games
// ---------------------------------------------------------------------------

/** Game ids a search scans between two yields to the event loop. */
export const SEARCH_SCAN_CHUNK = 20_000;
/** Matches a search keeps while counting: up to this many, the page comes from them (no second scan). */
const SEARCH_KEEP_IDS = 5_000;

/**
 * `GET /api/databases/:id/games`: newest first; `q` matches a player name or the event.
 * A search (a substring match, so no index helps) counts its matches over the database in id
 * ranges of `SEARCH_SCAN_CHUNK`, yielding to the event loop between them, so a search over a
 * large reference database never holds the server; when there are few matches the page is cut
 * from them, otherwise the newest-first scan stops as soon as the page is full.
 */
export async function databaseGames(
  db: Db,
  database: ViewableDatabase,
  query: { q?: string | undefined; page: number; pageSize: number },
): Promise<DbGamesPage> {
  const page = (sql: string, params: SqlValue[]): DbGamesPage['games'] =>
    db
      .all<DbGameRowRecord>(`SELECT ${DB_GAME_ROW_COLUMNS} FROM games g WHERE ${sql} ORDER BY g.ended_at DESC, g.id DESC LIMIT ? OFFSET ?`, [
        ...params,
        query.pageSize,
        (query.page - 1) * query.pageSize,
      ])
      .map(toDbGameRow);
  const paging = { page: query.page, pageSize: query.pageSize };
  const q = query.q?.trim();
  if (!q) {
    const total = db.value<number>('SELECT COUNT(*) FROM games g WHERE g.database_id = ?', [database.id]) ?? 0;
    return { total, ...paging, games: page('g.database_id = ?', [database.id]) };
  }
  const match = `(g.white_key LIKE ? ESCAPE '\\' OR g.black_key LIKE ? ESCAPE '\\' OR g.event LIKE ? ESCAPE '\\')`;
  const key = likeContains(playerKey(q));
  const matchParams = [key, key, likeContains(q)];
  const range = db.get<{ lo: Id | null; hi: Id | null }>('SELECT min(id) AS lo, max(id) AS hi FROM games WHERE database_id = ?', [database.id]);
  let total = 0;
  const kept: Id[] = [];
  if (range?.lo != null && range.hi != null) {
    for (let lo = range.lo; lo <= range.hi; lo += SEARCH_SCAN_CHUNK) {
      if (lo > range.lo) await yieldToLoop();
      const ids = db.all<{ id: Id }>(
        `SELECT g.id FROM games g WHERE g.database_id = ? AND g.id BETWEEN ? AND ? AND ${match}`,
        [database.id, lo, lo + SEARCH_SCAN_CHUNK - 1, ...matchParams],
      );
      total += ids.length;
      if (total <= SEARCH_KEEP_IDS) for (const r of ids) kept.push(r.id);
    }
  }
  if (total <= SEARCH_KEEP_IDS) return { total, ...paging, games: page('g.id IN (SELECT value FROM json_each(?))', [JSON.stringify(kept)]) };
  return { total, ...paging, games: page(`g.database_id = ? AND ${match}`, [database.id, ...matchParams]) };
}

const EXPORT_BATCH = 500;

/** The database as PGN text chunks, in import order (`GET /api/databases/:id/export.pgn`). */
export async function* exportDatabasePgn(db: Db, databaseId: Id): AsyncGenerator<string> {
  let lastId = 0;
  for (;;) {
    const rows = db.all<PgnGameRow>(
      `SELECT ${PGN_GAME_COLUMNS} FROM games g WHERE g.database_id = ? AND g.id > ? ORDER BY g.id LIMIT ?`,
      [databaseId, lastId, EXPORT_BATCH],
    );
    if (rows.length === 0) return;
    yield `${rows.map(gameToPgn).join('\n\n')}\n\n`;
    lastId = rows[rows.length - 1]!.id;
    if (rows.length < EXPORT_BATCH) return;
    // A fast client never makes the socket push back: let other requests in between batches.
    await yieldToLoop();
  }
}
