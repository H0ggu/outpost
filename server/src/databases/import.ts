/**
 * PGN imports into user databases (PLAN §5 "Custom PGN databases", §7 jobs, §10 upload limits).
 *
 * 1. The route streams the upload (multipart `.pgn`, ≤ 50 MB) or the pasted `{pgn}` text into
 *    `DATA_DIR/uploads/pgn-<uuid>.pgn` and enqueues a `pgnImport` job on the `local` lane
 *    (`enqueuePgnImport`; `database_imports` remembers which database it is for).
 * 2. The job (`runPgnImport`) streams the file: `parsePgnGames` → `pgnToNormalizedGame` →
 *    `insertGame` in short transactions of `IMPORT_BATCH` games. The duplicate check is the
 *    `UNIQUE(origin, origin_id)` key of `pgnOriginId` (same colours, date, players and position
 *    after ply 80 or the final position; per database). Progress counts `imported`, `duplicates`,
 *    `skipped` and `skip:<reason>`; the last progress is the import's summary.
 * 3. The upload is deleted once the import finished or can never succeed (database deleted,
 *    unreadable PGN). It is kept when the job was interrupted (shutdown, cancel) so a retry can
 *    run; `sweepUploads` removes leftovers older than a week at startup.
 *
 * Limits (disk and database growth per user): pasted PGN up to `MAX_PASTE_BYTES` (larger files go
 * through the streamed upload), at most `MAX_PENDING_IMPORTS` queued or running imports per user
 * (429), and at most `MAX_GAMES_PER_USER` games across a user's databases (admins: no limit; an
 * import stops when the owner reaches it).
 *
 * Files that are not valid UTF-8 (ChessBase and older tools write Windows-1252) are decoded as
 * Windows-1252 so names keep their accents.
 */
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import type { Readable } from 'node:stream';
import { PGN_PASTE_MAX_BYTES, PGN_UPLOAD_MAX_BYTES, type Id, type ImportResponse, type JobProgress } from '@outpost/shared/api';
import { getOpeningBook } from '../chess/openings.ts';
import { parsePgnGames, pgnToNormalizedGame, type PgnGame, type PgnSkipReason } from '../chess/pgn.ts';
import { insertGame, InvalidGameError, type NormalizedGame } from '../chess/store.ts';
import type { Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import { HttpError } from '../http/errors.ts';
import { enqueueJob, type JobContext } from '../jobs/index.ts';

/** Largest PGN upload (PLAN §10; the contract's `PGN_UPLOAD_MAX_BYTES`). */
export const MAX_PGN_BYTES = PGN_UPLOAD_MAX_BYTES;
/** Largest pasted PGN (the JSON body is buffered and parsed in memory: big files are uploaded). */
export const MAX_PASTE_BYTES = PGN_PASTE_MAX_BYTES;
/** Queued or running imports one user may have. */
export const MAX_PENDING_IMPORTS = 3;
/** Games one (non-admin) user may keep across their databases. */
export const MAX_GAMES_PER_USER = 2_000_000;
/** Games per write transaction (the event loop gets a turn between batches). */
export const IMPORT_BATCH = 100;
/** Uploads older than this with no pending job are removed at startup. */
export const STALE_UPLOAD_MS = 7 * 24 * 3_600_000;

const UPLOAD_RE = /^pgn-[0-9a-f-]{36}\.pgn$/;

/** Absolute path of an upload from its basename (rejects anything else). */
export function uploadPath(config: Config, file: string): string {
  const name = basename(file);
  if (name !== file || !UPLOAD_RE.test(name)) throw new Error(`Invalid upload name: ${file}`);
  return join(config.uploadsDir, name);
}

const newUploadName = (): string => `pgn-${randomUUID()}.pgn`;

/** Streams an upload to disk. 413 when it is larger than `MAX_PGN_BYTES`, 400 when empty. */
export async function saveUploadStream(config: Config, stream: Readable & { truncated?: boolean }): Promise<string> {
  await mkdir(config.uploadsDir, { recursive: true });
  const name = newUploadName();
  const path = join(config.uploadsDir, name);
  try {
    await pipeline(stream, createWriteStream(path, { flags: 'wx' }));
    if (stream.truncated) throw new HttpError(413, 'payload_too_large', `PGN files are limited to ${MAX_PGN_BYTES / 1024 / 1024} MB`);
    if ((await stat(path)).size === 0) throw new HttpError(400, 'bad_request', 'The file is empty');
    return name;
  } catch (e) {
    await rm(path, { force: true });
    if (e instanceof HttpError) throw e;
    // @fastify/multipart signals the size limit with a FST_REQ_FILE_TOO_LARGE error when throwFileSizeLimit is set.
    if ((e as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
      throw new HttpError(413, 'payload_too_large', `PGN files are limited to ${MAX_PGN_BYTES / 1024 / 1024} MB`);
    }
    throw e;
  }
}

/** Writes pasted PGN text to an upload file. */
export async function saveUploadText(config: Config, pgn: string): Promise<string> {
  await mkdir(config.uploadsDir, { recursive: true });
  const name = newUploadName();
  await writeFile(join(config.uploadsDir, name), pgn, { encoding: 'utf8', flag: 'wx' });
  return name;
}

/** Queued or running imports started by a user. */
export const pendingImports = (db: Db, userId: Id): number =>
  db.value<number>("SELECT COUNT(*) FROM jobs WHERE kind = 'pgnImport' AND user_id = ? AND status IN ('queued', 'running')", [userId]) ?? 0;

/**
 * Games the database's owner may still add (`MAX_GAMES_PER_USER` over all their databases), or
 * null when unlimited (admins, databases without an owner).
 */
export function remainingGameAllowance(db: Db, databaseId: Id): number | null {
  const owner = db.get<{ id: Id; role: string }>(
    'SELECT u.id, u.role FROM databases d JOIN users u ON u.id = d.owner_user_id WHERE d.id = ?',
    [databaseId],
  );
  if (!owner || owner.role === 'admin') return null;
  const stored = db.value<number>("SELECT COALESCE(SUM(game_count), 0) FROM databases WHERE owner_user_id = ? AND kind = 'games'", [owner.id]) ?? 0;
  return Math.max(0, MAX_GAMES_PER_USER - stored);
}

/**
 * Throws when `userId` may not start another import into the database right now: 429 with too
 * many imports pending, 403 when its owner has no game allowance left. Checked before an upload
 * is written to disk and again when it is queued.
 */
export function checkImportAllowed(db: Db, databaseId: Id, userId: Id): void {
  const pending = pendingImports(db, userId);
  if (pending >= MAX_PENDING_IMPORTS) {
    throw new HttpError(429, 'rate_limited', `You already have ${pending} imports waiting; try again when one has finished`, {
      pending,
      max: MAX_PENDING_IMPORTS,
    });
  }
  if (remainingGameAllowance(db, databaseId) === 0) {
    throw new HttpError(403, 'forbidden', `A user's databases hold at most ${MAX_GAMES_PER_USER.toLocaleString('en-US')} games`);
  }
}

/** Queues the import of an upload into a database (rechecking `checkImportAllowed`). */
export function enqueuePgnImport(db: Db, databaseId: Id, file: string, originalName: string | null, userId: Id): ImportResponse {
  return db.tx(() => {
    checkImportAllowed(db, databaseId, userId);
    const job = enqueueJob(db, 'pgnImport', { databaseId, file, originalName }, { userId });
    db.run('INSERT OR REPLACE INTO database_imports (job_id, database_id, file, created_at) VALUES (?, ?, ?, ?)', [
      job.id,
      databaseId,
      file,
      Date.now(),
    ]);
    return { job };
  });
}

/** Removes an upload and forgets it. */
async function dropUpload(db: Db, config: Config, file: string): Promise<void> {
  try {
    await rm(uploadPath(config, file), { force: true });
  } catch {
    // invalid name: nothing on disk to remove
  }
  db.run('UPDATE database_imports SET file = NULL WHERE file = ?', [file]);
}

/** Deletes the pending uploads of a database (it is being deleted). */
export async function dropDatabaseUploads(db: Db, config: Config, databaseId: Id): Promise<void> {
  for (const r of db.all<{ file: string }>('SELECT file FROM database_imports WHERE database_id = ? AND file IS NOT NULL', [databaseId])) {
    await dropUpload(db, config, r.file);
  }
}

/**
 * Removes uploads older than `STALE_UPLOAD_MS` that no queued or running import still needs
 * (left behind by interrupted or failed jobs). Best effort; returns the number removed.
 */
export async function sweepUploads(db: Db, config: Config, now = Date.now()): Promise<number> {
  let names: string[];
  try {
    names = await readdir(config.uploadsDir);
  } catch {
    return 0;
  }
  const pending = new Set(
    db
      .all<{ file: string }>(
        `SELECT di.file FROM database_imports di JOIN jobs j ON j.id = di.job_id
          WHERE di.file IS NOT NULL AND j.status IN ('queued', 'running')`,
      )
      .map(r => r.file),
  );
  let removed = 0;
  for (const name of names) {
    if (!UPLOAD_RE.test(name) || pending.has(name)) continue;
    try {
      const st = await stat(join(config.uploadsDir, name));
      if (now - st.mtimeMs < STALE_UPLOAD_MS) continue;
      await dropUpload(db, config, name);
      removed++;
    } catch {
      // raced with another removal
    }
  }
  return removed;
}

/** Whether the first part of a file is valid UTF-8 (else it is read as Windows-1252). */
async function looksUtf8(path: string): Promise<boolean> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    try {
      // `stream` while the sample may end inside a multi-byte sequence: that tail is not an error.
      new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, bytesRead), { stream: bytesRead === buf.length });
      return true;
    } catch {
      return false;
    }
  } finally {
    await fh.close();
  }
}

/** The file as text chunks in the right encoding. */
async function* textChunks(path: string): AsyncGenerator<string> {
  const decoder = new TextDecoder((await looksUtf8(path)) ? 'utf-8' : 'windows-1252');
  for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 })) {
    yield decoder.decode(chunk as Buffer, { stream: true });
  }
  const rest = decoder.decode();
  if (rest) yield rest;
}

const SKIP_LABELS: Record<PgnSkipReason, string> = {
  variant: 'variant',
  fromPosition: 'from a set-up position',
  noResult: 'unfinished',
  noMoves: 'no moves',
  illegalMove: 'illegal move',
};

/** Human summary of the counters. */
export function importSummary(counts: Record<string, number>): string {
  const parts = [`${counts.imported ?? 0} imported`, `${counts.duplicates ?? 0} duplicate${counts.duplicates === 1 ? '' : 's'}`];
  const skipped = counts.skipped ?? 0;
  if (skipped) {
    const reasons = (Object.keys(SKIP_LABELS) as PgnSkipReason[])
      .filter(r => (counts[`skip:${r}`] ?? 0) > 0)
      .map(r => `${counts[`skip:${r}`]} ${SKIP_LABELS[r]}`);
    parts.push(`${skipped} skipped (${reasons.join(', ')})`);
  } else parts.push('0 skipped');
  return parts.join(', ');
}

/**
 * The `pgnImport` job handler (registered by routes/databases.ts). See the module comment.
 */
export async function runPgnImport(ctx: JobContext<'pgnImport'>): Promise<void> {
  const { db, config } = ctx;
  const { databaseId, file } = ctx.job.payload;
  const path = uploadPath(config, file);
  const target = db.get<{ id: Id; kind: 'games' | 'reference' }>('SELECT id, kind FROM databases WHERE id = ?', [databaseId]);
  if (!target) {
    await dropUpload(db, config, file);
    ctx.progress({ done: 0, total: null, message: 'The database was deleted before the import ran' });
    return;
  }
  try {
    await stat(path);
  } catch {
    db.run('UPDATE database_imports SET file = NULL WHERE file = ?', [file]);
    throw new Error('The uploaded PGN is no longer available; upload it again');
  }

  const origin = target.kind === 'reference' ? 'reference' : 'pgn';
  const openings = getOpeningBook(config.openingsDir);
  const counts: Record<string, number> = { imported: 0, duplicates: 0, skipped: 0 };
  let limitReached = false;
  let parsed = 0;
  let batch: NormalizedGame[] = [];
  const skip = (reason: PgnSkipReason): void => {
    counts.skipped = (counts.skipped ?? 0) + 1;
    counts[`skip:${reason}`] = (counts[`skip:${reason}`] ?? 0) + 1;
  };
  const report = (message: string | null): void => {
    const p: JobProgress = { done: parsed, total: null, message, counts: { ...counts } };
    ctx.progress(p);
  };
  const flush = (): void => {
    if (batch.length === 0) return;
    const games = batch;
    batch = [];
    db.tx(() => {
      if (db.value('SELECT 1 FROM databases WHERE id = ?', [databaseId]) === undefined) throw new DatabaseGoneError();
      if (remainingGameAllowance(db, databaseId) === 0) {
        limitReached = true;
        return;
      }
      let inserted = 0;
      for (const g of games) {
        try {
          const r = insertGame(db, g, { openings });
          if (r.inserted) inserted++;
          else counts.duplicates = (counts.duplicates ?? 0) + 1;
        } catch (e) {
          if (!(e instanceof InvalidGameError)) throw e;
          skip('illegalMove');
        }
      }
      counts.imported = (counts.imported ?? 0) + inserted;
      if (inserted) db.run('UPDATE databases SET game_count = game_count + ? WHERE id = ?', [inserted, databaseId]);
    });
    report(`${parsed} games read`);
  };
  const finish = (): void => {
    db.run('UPDATE databases SET game_count = (SELECT COUNT(*) FROM games WHERE database_id = ?1) WHERE id = ?1', [databaseId]);
    db.run("UPDATE sources SET last_synced_at = ?, last_sync_error = NULL WHERE kind = 'pgn' AND database_id = ?", [Date.now(), databaseId]);
  };

  const games = parsePgnGames(textChunks(path))[Symbol.asyncIterator]();
  try {
    for (;;) {
      if (ctx.signal.aborted) throw ctx.signal.reason ?? new Error('Import cancelled');
      let next: IteratorResult<PgnGame>;
      try {
        next = await games.next();
      } catch (e) {
        // A game the parser refuses (corrupt or hostile file): keep what was imported, stop here.
        flush();
        finish();
        const message = `Stopped after ${parsed} games: the PGN could not be read further (${(e as Error).message || 'parse error'}). ${importSummary(counts)}`;
        report(message);
        await dropUpload(db, config, file);
        throw new Error(message, { cause: e });
      }
      if (next.done) break;
      parsed++;
      const g = pgnToNormalizedGame(next.value, { origin, databaseId });
      if ('skip' in g) skip(g.skip);
      else batch.push(g);
      if (batch.length >= IMPORT_BATCH) {
        flush();
        if (limitReached) break;
        await yieldToLoop();
      }
    }
    if (!limitReached) flush();
  } catch (e) {
    if (e instanceof DatabaseGoneError) {
      await dropUpload(db, config, file);
      report('The database was deleted during the import');
      return;
    }
    throw e;
  } finally {
    await games.return?.(undefined).catch(() => {});
  }
  finish();
  report(
    limitReached
      ? `Stopped after ${parsed} games: the owner's databases hold the most games allowed (${MAX_GAMES_PER_USER.toLocaleString('en-US')}). ${importSummary(counts)}`
      : importSummary(counts),
  );
  await dropUpload(db, config, file);
}

class DatabaseGoneError extends Error {
  override name = 'DatabaseGoneError';
}
