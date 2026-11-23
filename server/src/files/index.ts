/**
 * Studio "My Files" (PLAN §4 `files`, §8.4): PGN studies and repertoires in folders, a recycle
 * bin, and a search for files that reach a position.
 *
 * - Every function takes the owner's user id: users only ever see their own files (404 otherwise).
 * - Folders are slash-separated paths stored on each file (`''` = root); a folder exists while it
 *   holds files (or sub-folders that do).
 * - DELETE moves a file to the recycle bin (`deleted_at`); deleting a file that is already in the
 *   bin removes it for good. Restore takes it back out.
 * - Position search: every non-deleted file is indexed once per PGN revision (`file_index` and
 *   `file_positions`, migration 500): each position of each game, main line and variations,
 *   parsed with chessops and keyed by `posKey(EPD)` like the games index, so move order and
 *   move counters don't matter. Saving new PGN (or moving the file to the bin) drops the file's
 *   index; the next search rebuilds it. Indexing never holds the event loop for long: the PGN is
 *   parsed in chunks with chessops' streaming parser, move trees are walked and rows written in
 *   batches, with a yield in between; a file saved meanwhile is simply indexed again later.
 * - Limits per user: `MAX_FILES_PER_USER` files and `MAX_FILE_BYTES_PER_USER` bytes of PGN (bin
 *   included), `MAX_INDEXED_POSITIONS_PER_USER` indexed positions; saves and searches are
 *   throttled per user in routes/files.ts.
 */
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import { Chess, type Position } from 'chessops/chess';
import { parseFen } from 'chessops/fen';
import { PgnParser, parseVariant, startingPosition, type ChildNode, type Game, type PgnNodeData } from 'chessops/pgn';
import { makeSanAndPlay, parseSan } from 'chessops/san';
import type {
  Color,
  CreateFileRequest,
  EpochMs,
  FileKind,
  FileSearchHit,
  FileSearchResponse,
  FolderInfo,
  FoldersResponse,
  Id,
  StudioFile,
  StudioFileMeta,
  UpdateFileRequest,
} from '@outpost/shared/api';
import { epdOf } from '@outpost/shared/chess';
import { z } from 'zod';
import { posKey } from '../chess/posKey.ts';
import type { Db } from '../db/index.ts';
import { conflict, forbidden, HttpError, notFound, validationError } from '../http/errors.ts';

// ---------------------------------------------------------------------------
// Limits and schemas
// ---------------------------------------------------------------------------

/** Largest PGN of one file (characters). */
export const MAX_FILE_PGN = 10 * 1024 * 1024;
/** Most files (bin included) per user. */
export const MAX_FILES_PER_USER = 10_000;
/** Most PGN bytes (UTF-8, bin included) per user. */
export const MAX_FILE_BYTES_PER_USER = 100 * 1024 * 1024;
/** Most indexed positions per user across their files (files beyond it are not searchable). */
export const MAX_INDEXED_POSITIONS_PER_USER = 2_000_000;
/** Deepest folder nesting. */
export const MAX_FOLDER_DEPTH = 8;
/** Positions indexed per file at most (very large repertoires are searched up to here). */
export const MAX_INDEXED_POSITIONS = 250_000;
/** Search answers at most this many files, and this many matches per file. */
export const MAX_SEARCH_FILES = 100;
export const MAX_MATCHES_PER_FILE = 50;

const CONTROL = /[\u0000-\u001f\u007f]/;

/** Normalises a folder path: trims each segment, drops empty ones, joins with `/`. */
export function normalizeFolder(raw: string): string {
  return raw
    .split('/')
    .map(s => s.trim())
    .filter(s => s !== '')
    .join('/');
}

/** A folder path (normalised). */
export const folderSchema = z
  .string()
  .max(512)
  .transform(normalizeFolder)
  .superRefine((path, ctx) => {
    const parts = path === '' ? [] : path.split('/');
    if (parts.length > MAX_FOLDER_DEPTH) ctx.addIssue({ code: 'custom', message: `folders nest at most ${MAX_FOLDER_DEPTH} deep` });
    for (const p of parts) {
      if (p === '.' || p === '..') ctx.addIssue({ code: 'custom', message: 'folder names cannot be . or ..' });
      else if (p.length > 64) ctx.addIssue({ code: 'custom', message: 'folder names are at most 64 characters' });
      else if (CONTROL.test(p)) ctx.addIssue({ code: 'custom', message: 'control characters are not allowed' });
    }
  });

const nameSchema = z
  .string()
  .trim()
  .min(1, 'enter a name')
  .max(200)
  .refine(s => !CONTROL.test(s) && !s.includes('/'), 'names cannot contain / or control characters');
const pgnSchema = z.string().max(MAX_FILE_PGN, `files are limited to ${MAX_FILE_PGN / 1024 / 1024} MB of PGN`);
const kindSchema = z.enum(['study', 'repertoire']);
const colorSchema = z.enum(['white', 'black']).nullable();

/** `CreateFileRequest`. */
export const createFileSchema = z.object({
  folder: folderSchema,
  name: nameSchema,
  kind: kindSchema,
  color: colorSchema.optional(),
  pgn: pgnSchema,
});

/** `UpdateFileRequest`. */
export const updateFileSchema = z.object({
  folder: folderSchema.optional(),
  name: nameSchema.optional(),
  kind: kindSchema.optional(),
  color: colorSchema.optional(),
  pgn: pgnSchema.optional(),
  baseUpdatedAt: z.number().int().nonnegative().optional(),
});

/** `FilesQuery`. */
export const filesQuerySchema = z.object({
  folder: folderSchema.optional(),
  trash: z.enum(['1', 'true']).optional(),
});

/** `GET /api/files/search` query. */
export const fileSearchQuerySchema = z.object({ fen: z.string().trim().min(1).max(200) });

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

interface FileRow {
  id: Id;
  folder: string;
  name: string;
  kind: FileKind;
  color: Color | null;
  created_at: EpochMs;
  updated_at: EpochMs;
  deleted_at: EpochMs | null;
}

const META_COLUMNS = 'id, folder, name, kind, color, created_at, updated_at, deleted_at';

const toMeta = (r: FileRow): StudioFileMeta => ({
  id: r.id,
  folder: r.folder,
  name: r.name,
  kind: r.kind,
  color: r.color,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  deletedAt: r.deleted_at,
});

/** One of the user's files with its PGN (404 for anything else, including other users' files). */
export function getFile(db: Db, userId: Id, id: Id): StudioFile {
  const row = db.get<FileRow & { pgn: string }>(`SELECT ${META_COLUMNS}, pgn FROM files WHERE id = ? AND owner_user_id = ?`, [id, userId]);
  if (!row) throw notFound('File not found');
  return { ...toMeta(row), pgn: row.pgn };
}

/** `GET /api/files`: one folder or all folders, or the recycle bin (newest deletion first). */
export function listFiles(db: Db, userId: Id, query: { folder?: string | undefined; trash?: string | undefined }): StudioFileMeta[] {
  if (query.trash) {
    return db
      .all<FileRow>(`SELECT ${META_COLUMNS} FROM files WHERE owner_user_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC, id DESC`, [userId])
      .map(toMeta);
  }
  if (query.folder !== undefined) {
    return db
      .all<FileRow>(
        `SELECT ${META_COLUMNS} FROM files WHERE owner_user_id = ? AND deleted_at IS NULL AND folder = ? ORDER BY name COLLATE NOCASE, id`,
        [userId, query.folder],
      )
      .map(toMeta);
  }
  return db
    .all<FileRow>(
      `SELECT ${META_COLUMNS} FROM files WHERE owner_user_id = ? AND deleted_at IS NULL ORDER BY folder COLLATE NOCASE, name COLLATE NOCASE, id`,
      [userId],
    )
    .map(toMeta);
}

/** `GET /api/folders`: every folder with files (and its parents), plus the bin's size. */
export function listFolders(db: Db, userId: Id): FoldersResponse {
  const counts = new Map<string, number>([['', 0]]);
  for (const r of db.all<{ folder: string; n: number }>(
    'SELECT folder, COUNT(*) AS n FROM files WHERE owner_user_id = ? AND deleted_at IS NULL GROUP BY folder',
    [userId],
  )) {
    counts.set(r.folder, r.n);
    const parts = r.folder.split('/');
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('/');
      if (!counts.has(parent)) counts.set(parent, 0);
    }
  }
  const folders: FolderInfo[] = [...counts]
    .map(([path, fileCount]) => ({ path, fileCount }))
    .sort((a, b) => a.path.localeCompare(b.path, 'en', { sensitivity: 'base' }));
  const trashCount = db.value<number>('SELECT COUNT(*) FROM files WHERE owner_user_id = ? AND deleted_at IS NOT NULL', [userId]) ?? 0;
  return { folders, trashCount };
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/** Drops a file's position index (its PGN changed). */
const dropIndex = (db: Db, id: Id): void => {
  db.run('DELETE FROM file_positions WHERE file_id = ?', [id]);
  db.run('DELETE FROM file_index WHERE file_id = ?', [id]);
};

/** PGN bytes the user stores (bin included), from the covering index of migration 503. */
const storedBytes = (db: Db, userId: Id): number =>
  db.value<number>('SELECT COALESCE(SUM(pgn_bytes), 0) FROM files WHERE owner_user_id = ?', [userId]) ?? 0;

/** 403 when storing `bytes` more would take the user over `MAX_FILE_BYTES_PER_USER`. */
function checkQuota(db: Db, userId: Id, addedBytes: number): void {
  if (addedBytes <= 0) return;
  const used = storedBytes(db, userId);
  if (used + addedBytes > MAX_FILE_BYTES_PER_USER) {
    const mb = (n: number): string => `${Math.round((n / 1024 / 1024) * 10) / 10} MB`;
    throw new HttpError(403, 'forbidden', `Your files may hold ${mb(MAX_FILE_BYTES_PER_USER)} of PGN (${mb(used)} used); delete files or empty the recycle bin`, {
      usedBytes: used,
      maxBytes: MAX_FILE_BYTES_PER_USER,
    });
  }
}

/** `POST /api/files`. A study has no colour; a repertoire may name its side. */
export function createFile(db: Db, userId: Id, body: CreateFileRequest): StudioFile {
  const id = db.tx(() => {
    const count = db.value<number>('SELECT COUNT(*) FROM files WHERE owner_user_id = ?', [userId]) ?? 0;
    if (count >= MAX_FILES_PER_USER) throw forbidden(`You can keep at most ${MAX_FILES_PER_USER} files; empty the recycle bin`);
    const bytes = Buffer.byteLength(body.pgn, 'utf8');
    checkQuota(db, userId, bytes);
    const now = Date.now();
    return db.run(
      `INSERT INTO files (owner_user_id, folder, name, kind, color, pgn, pgn_bytes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, body.folder, body.name, body.kind, body.kind === 'repertoire' ? (body.color ?? null) : null, body.pgn, bytes, now, now],
    ).lastInsertRowid;
  });
  return getFile(db, userId, id);
}

/**
 * `PUT /api/files/:id`: any subset of the fields. With `baseUpdatedAt`, a file saved since then
 * (another tab or device) is a 409 `conflict` (`details.updatedAt`). Files in the bin are
 * read-only until restored (409).
 */
export function updateFile(db: Db, userId: Id, id: Id, patch: UpdateFileRequest): StudioFile {
  return db.tx(() => {
    const cur = db.get<FileRow & { pgn_bytes: number }>(`SELECT ${META_COLUMNS}, pgn_bytes FROM files WHERE id = ? AND owner_user_id = ?`, [
      id,
      userId,
    ]);
    if (!cur) throw notFound('File not found');
    if (cur.deleted_at !== null) throw conflict('The file is in the recycle bin; restore it first', { deletedAt: cur.deleted_at });
    if (patch.baseUpdatedAt !== undefined && cur.updated_at > patch.baseUpdatedAt) {
      throw conflict('The file was saved elsewhere since you opened it', { updatedAt: cur.updated_at });
    }
    const kind = patch.kind ?? cur.kind;
    const color = kind === 'study' ? null : patch.color !== undefined ? patch.color : cur.color;
    const updatedAt = Math.max(Date.now(), cur.updated_at + 1);
    const bytes = patch.pgn !== undefined ? Buffer.byteLength(patch.pgn, 'utf8') : cur.pgn_bytes;
    checkQuota(db, userId, bytes - cur.pgn_bytes);
    db.run(
      `UPDATE files SET folder = ?, name = ?, kind = ?, color = ?, pgn = COALESCE(?, pgn), pgn_bytes = ?, updated_at = ? WHERE id = ?`,
      [patch.folder ?? cur.folder, patch.name ?? cur.name, kind, color, patch.pgn ?? null, bytes, updatedAt, id],
    );
    if (patch.pgn !== undefined) dropIndex(db, id);
    return getFile(db, userId, id);
  });
}

/** `DELETE /api/files/:id`: into the bin, or for good when it is already there. */
export function deleteFile(db: Db, userId: Id, id: Id): void {
  const cur = db.get<{ deleted_at: EpochMs | null }>('SELECT deleted_at FROM files WHERE id = ? AND owner_user_id = ?', [id, userId]);
  if (!cur) throw notFound('File not found');
  db.tx(() => {
    // A binned file is not searched: its index goes (and is rebuilt if it comes back).
    if (cur.deleted_at === null) {
      db.run('UPDATE files SET deleted_at = ? WHERE id = ?', [Date.now(), id]);
      dropIndex(db, id);
    } else db.run('DELETE FROM files WHERE id = ?', [id]);
  });
}

/** `POST /api/files/:id/restore`: out of the bin (a file not in the bin is returned unchanged). */
export function restoreFile(db: Db, userId: Id, id: Id): StudioFile {
  db.run('UPDATE files SET deleted_at = NULL WHERE id = ? AND owner_user_id = ? AND deleted_at IS NOT NULL', [id, userId]);
  return getFile(db, userId, id);
}

// ---------------------------------------------------------------------------
// Position index and search
// ---------------------------------------------------------------------------

/** One indexed occurrence. */
export interface FilePosition {
  key: number;
  gameIndex: number;
  ply: number;
  nextSan: string | null;
}

/** Result of `indexPgnPositions`. */
export interface PgnIndex {
  positions: FilePosition[];
  /** Games read (all of them unless the index was truncated or the PGN stopped parsing). */
  games: number;
  truncated: boolean;
  error: string | null;
}

/** lila's ply of a position: half-moves since move 1, White to move. */
const plyOf = (pos: Position): number => (pos.fullmoves - 1) * 2 + (pos.turn === 'white' ? 0 : 1);

/** PGN characters parsed per step, and tree nodes walked per step, between yields. */
const PARSE_CHUNK = 64 * 1024;
const WALK_STEP = 2000;

/**
 * Every position of every game in `pgn` (main line and variations), each with the move played
 * next in that line. Games in other variants or with an invalid start are skipped; a line with an
 * illegal move ends there. Stops after `limit` rows (`truncated`). Parses in chunks and yields to
 * the event loop between steps, so a 10 MB file doesn't block the server.
 */
export async function indexPgnPositions(pgn: string, limit = MAX_INDEXED_POSITIONS): Promise<PgnIndex> {
  const parsed: Array<Game<PgnNodeData>> = [];
  let gamesRead = 0;
  let error: string | null = null;
  // Generous budget per game: repertoires are single games with very many moves; size is capped on save.
  const parser = new PgnParser(
    (game, err) => {
      if (err) error ??= `PGN parse error after game ${gamesRead}: ${err.message || 'too complex'}`;
      else {
        gamesRead++;
        parsed.push(game);
      }
    },
    undefined,
    50_000_000,
  );

  const out: FilePosition[] = [];
  const seen = new Set<string>();
  let truncated = false;
  let walked = 0;
  let gameIndex = -1;
  const add = (key: number, gi: number, ply: number, nextSan: string | null): void => {
    const id = `${key}|${gi}|${ply}|${nextSan ?? ''}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ key, gameIndex: gi, ply, nextSan });
  };

  /** Walks one game's move tree depth-first, main line first. */
  const walk = async (game: Game<PgnNodeData>, gi: number): Promise<void> => {
    if (parseVariant(game.headers.get('Variant')) !== 'chess') return;
    const start = startingPosition(game.headers);
    if (start.isErr) return;
    const stack: Array<{ pos: Position; children: Array<ChildNode<PgnNodeData>> }> = [{ pos: start.value, children: game.moves.children }];
    while (stack.length) {
      if (out.length >= limit) {
        truncated = true;
        return;
      }
      if (++walked % WALK_STEP === 0) await yieldToLoop();
      const { pos, children } = stack.pop()!;
      const key = posKey(epdOf(pos));
      const ply = plyOf(pos);
      const next: Array<{ pos: Position; children: Array<ChildNode<PgnNodeData>> }> = [];
      let played = false;
      for (const child of children) {
        const move = parseSan(pos, child.data.san);
        if (!move) continue;
        const after = pos.clone();
        const san = makeSanAndPlay(after, move);
        add(key, gi, ply, san);
        played = true;
        next.push({ pos: after, children: child.children });
      }
      if (!played) add(key, gi, ply, null);
      for (let i = next.length - 1; i >= 0; i--) stack.push(next[i]!);
    }
  };

  let offset = 0;
  for (;;) {
    const end = Math.min(pgn.length, offset + PARSE_CHUNK);
    const final = end >= pgn.length;
    parser.parse(pgn.slice(offset, end), final ? undefined : { stream: true });
    offset = end;
    while (parsed.length && !truncated) await walk(parsed.shift()!, ++gameIndex);
    // A parse error ends the file: what follows can't be read reliably.
    if (final || truncated || error !== null) break;
    await yieldToLoop();
  }
  return { positions: out, games: gamesRead, truncated, error };
}

/** Rows written per transaction while storing an index. */
const INDEX_WRITE_BATCH = 5000;

/** Indexed positions of the user's (non-deleted) files. */
const indexedPositions = (db: Db, userId: Id): number =>
  db.value<number>(
    `SELECT COALESCE(SUM(fi.positions), 0) FROM file_index fi JOIN files f ON f.id = fi.file_id
      WHERE f.owner_user_id = ? AND f.deleted_at IS NULL`,
    [userId],
  ) ?? 0;

/**
 * Builds the index of one file revision. Rows go in short transactions; each checks the file is
 * still that revision (same `updated_at`, not in the bin) and gives up otherwise (the next search
 * indexes the new revision). The `file_index` row is written last, with the final batch.
 */
async function indexFile(db: Db, userId: Id, id: Id): Promise<void> {
  const file = db.get<{ pgn: string; updated_at: EpochMs }>('SELECT pgn, updated_at FROM files WHERE id = ? AND deleted_at IS NULL', [id]);
  if (!file) return;
  const budget = Math.max(0, MAX_INDEXED_POSITIONS_PER_USER - indexedPositions(db, userId));
  const limit = Math.min(MAX_INDEXED_POSITIONS, budget);
  const r = limit > 0 ? await indexPgnPositions(file.pgn, limit) : { positions: [], games: 0, truncated: true, error: null };
  const note =
    [
      r.error,
      r.truncated
        ? limit < MAX_INDEXED_POSITIONS
          ? `your files' position index is full (${MAX_INDEXED_POSITIONS_PER_USER.toLocaleString('en-US')} positions): indexed the first ${limit} positions only`
          : `indexed the first ${MAX_INDEXED_POSITIONS} positions only`
        : null,
    ]
      .filter(Boolean)
      .join('; ') || null;
  const sameRevision = (): boolean =>
    db.value('SELECT 1 FROM files WHERE id = ? AND updated_at = ? AND deleted_at IS NULL', [id, file.updated_at]) !== undefined &&
    db.value('SELECT 1 FROM file_index WHERE file_id = ?', [id]) === undefined;

  for (let i = 0; ; i += INDEX_WRITE_BATCH) {
    const last = i + INDEX_WRITE_BATCH >= r.positions.length;
    const ok = db.tx(() => {
      if (!sameRevision()) {
        // Saved, binned or indexed by someone else meanwhile: drop what this run wrote.
        if (db.value('SELECT 1 FROM file_index WHERE file_id = ?', [id]) === undefined) db.run('DELETE FROM file_positions WHERE file_id = ?', [id]);
        return false;
      }
      if (i === 0) db.run('DELETE FROM file_positions WHERE file_id = ?', [id]);
      for (const p of r.positions.slice(i, i + INDEX_WRITE_BATCH)) {
        db.run('INSERT INTO file_positions (file_id, pos_key, game_index, ply, next_san) VALUES (?, ?, ?, ?, ?)', [
          id,
          p.key,
          p.gameIndex,
          p.ply,
          p.nextSan,
        ]);
      }
      if (last) {
        db.run('INSERT INTO file_index (file_id, indexed_at, games, error, positions) VALUES (?, ?, ?, ?, ?)', [
          id,
          Date.now(),
          r.games,
          note,
          r.positions.length,
        ]);
      }
      return true;
    });
    if (!ok || last) return;
    await yieldToLoop();
  }
}

/** Index builds in progress, per database and file (concurrent searches share them). */
const building = new WeakMap<Db, Map<Id, Promise<void>>>();

/**
 * Indexes the user's files that changed since their last index (most recently saved first, so
 * the position budget goes to current work), one file at a time. Returns how many were (re)built.
 */
export async function refreshFileIndex(db: Db, userId: Id): Promise<number> {
  let inFlight = building.get(db);
  if (!inFlight) building.set(db, (inFlight = new Map()));
  const stale = db.all<{ id: Id }>(
    `SELECT f.id FROM files f LEFT JOIN file_index fi ON fi.file_id = f.id
      WHERE f.owner_user_id = ? AND f.deleted_at IS NULL AND fi.file_id IS NULL
      ORDER BY f.updated_at DESC, f.id DESC`,
    [userId],
  );
  for (const { id } of stale) {
    let p = inFlight.get(id);
    if (!p) {
      const map = inFlight;
      p = indexFile(db, userId, id).finally(() => map.delete(id));
      inFlight.set(id, p);
    }
    await p;
  }
  return stale.length;
}

/** The EPD-based key of a FEN, or a 400. */
export function fenKey(fen: string): number {
  const setup = parseFen(fen);
  if (setup.isErr) throw validationError('fen: not a valid FEN', { issues: [{ path: 'fen', message: setup.error.message }] });
  const pos = Chess.fromSetup(setup.value);
  if (pos.isErr) throw validationError('fen: not a legal position', { issues: [{ path: 'fen', message: pos.error.message }] });
  return posKey(epdOf(pos.value));
}

/**
 * `GET /api/files/search?fen=`: the user's files (not in the bin) whose PGN reaches the position
 * anywhere (main line or variation), most recently saved first.
 */
export async function searchFiles(db: Db, userId: Id, fen: string): Promise<FileSearchResponse> {
  const key = fenKey(fen);
  await refreshFileIndex(db, userId);
  // Complete indexes only (file_index is written with the last batch of rows).
  const rows = db.all<FileRow & { game_index: number; ply: number; next_san: string | null }>(
    `SELECT f.id, f.folder, f.name, f.kind, f.color, f.created_at, f.updated_at, f.deleted_at, fp.game_index, fp.ply, fp.next_san
       FROM file_positions fp JOIN files f ON f.id = fp.file_id JOIN file_index fi ON fi.file_id = f.id
      WHERE fp.pos_key = ? AND f.owner_user_id = ? AND f.deleted_at IS NULL
      ORDER BY f.updated_at DESC, f.id DESC, fp.game_index, fp.ply, fp.rowid`,
    [key, userId],
  );
  const hits: FileSearchHit[] = [];
  const byId = new Map<Id, FileSearchHit>();
  for (const r of rows) {
    let hit = byId.get(r.id);
    if (!hit) {
      if (hits.length >= MAX_SEARCH_FILES) continue;
      hit = { file: toMeta(r), matches: [] };
      byId.set(r.id, hit);
      hits.push(hit);
    }
    if (hit.matches.length < MAX_MATCHES_PER_FILE) hit.matches.push({ gameIndex: r.game_index, ply: r.ply, nextSan: r.next_san });
  }
  return { fen, hits };
}
