/**
 * User PGN databases (PLAN §4 `databases`, §5 "Custom PGN databases", §6): CRUD with ownership and
 * visibility, game lists, single-game delete, streamed export, and the import pipeline
 * (`import.ts`). Reference databases are readable here too (instance-wide data); only admins may
 * change them, and their imports go through the reference module.
 *
 * Access: `loadDatabaseForViewer` (src/profiles/access.ts): owner or admin edit a `games`
 * database; others see it only while it is public (404 otherwise).
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
import type { Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import { forbidden, notFound } from '../http/errors.ts';
import type { AuthUser } from '../http/types.ts';
import { getJob } from '../jobs/index.ts';
import type { ViewableDatabase } from '../profiles/access.ts';
import { DB_GAME_ROW_COLUMNS, likeContains, toDbGameRow, type DbGameRowRecord } from '../stats/index.ts';
import { dropDatabaseUploads } from './import.ts';
import { gameToPgn, PGN_GAME_COLUMNS, type PgnGameRow } from './pgnWriter.ts';

export {
  enqueuePgnImport,
  importSummary,
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
    canEdit: canEditRow(row, viewer),
    ...importJobs(db, row.id),
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

/** `GET /api/databases`: my `games` databases first, then the public ones of others (by name). */
export function listDatabases(db: Db, viewer: AuthUser | null): DatabaseInfo[] {
  const rows = db.all<DatabaseRow>(
    `SELECT ${DATABASE_COLUMNS} FROM databases d LEFT JOIN users u ON u.id = d.owner_user_id
      WHERE d.kind = 'games' AND (d.visibility = 'public' OR d.owner_user_id = ?)
      ORDER BY (d.owner_user_id IS ?) DESC, d.name COLLATE NOCASE, d.id`,
    [viewer?.id ?? null, viewer?.id ?? -1],
  );
  return rows.map(r => toInfo(db, r, viewer));
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

/** `PATCH /api/databases/:id`. */
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
  if (sets.length) db.run(`UPDATE databases SET ${sets.join(', ')} WHERE id = ?`, [...params, database.id]);
}

const DELETE_BATCH = 500;

/**
 * `DELETE /api/databases/:id`: its games (with positions and player_games), its `pgn` sources
 * (detached from every profile) and its pending uploads. Games go in short batches so the server
 * stays responsive while a large database is removed.
 */
export async function deleteDatabase(db: Db, config: Config, database: ViewableDatabase): Promise<void> {
  requireDatabaseEditor(database);
  await dropDatabaseUploads(db, config, database.id);
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

/** `GET /api/databases/:id/games`: newest first; `q` matches a player name or the event. */
export function databaseGames(db: Db, database: ViewableDatabase, query: { q?: string | undefined; page: number; pageSize: number }): DbGamesPage {
  const where = ['g.database_id = ?'];
  const params: Array<string | number> = [database.id];
  const q = query.q?.trim();
  if (q) {
    where.push(`(g.white_key LIKE ? ESCAPE '\\' OR g.black_key LIKE ? ESCAPE '\\' OR g.event LIKE ? ESCAPE '\\')`);
    const key = likeContains(playerKey(q));
    params.push(key, key, likeContains(q));
  }
  const sql = where.join(' AND ');
  const total = db.value<number>(`SELECT COUNT(*) FROM games g WHERE ${sql}`, params) ?? 0;
  const games = db
    .all<DbGameRowRecord>(`SELECT ${DB_GAME_ROW_COLUMNS} FROM games g WHERE ${sql} ORDER BY g.ended_at DESC, g.id DESC LIMIT ? OFFSET ?`, [
      ...params,
      query.pageSize,
      (query.page - 1) * query.pageSize,
    ])
    .map(toDbGameRow);
  return { total, page: query.page, pageSize: query.pageSize, games };
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
  }
}
