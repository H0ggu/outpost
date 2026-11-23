/**
 * Reference PGN uploads (PLAN §10: up to 2 GB, streamed to disk): the multipart body goes straight to
 * `${DATA_DIR}/uploads/reference-<time>-<random>.upload`, the 'referenceImport' job reads it and
 * deletes it when done. Files of cancelled or crashed jobs are swept once no active job uses them.
 */
import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyRequest } from 'fastify';
import type { Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import { badRequest, HttpError } from '../http/errors.ts';
import { REFERENCE_LIMITS, SizeLimitError } from './stream.ts';

const UPLOAD_NAME_RE = /^reference-\d+-[0-9a-f]{16}\.upload$/;
/** Text fields accepted next to the file (ReferenceImportRequest). */
const MAX_FIELDS = 10;
const MAX_FIELD_BYTES = 4096;

/** Absolute path of an upload named in a job payload, or null when the name is not one of ours. */
export function uploadPath(config: Config, file: string): string | null {
  const name = basename(file);
  return name === file && UPLOAD_NAME_RE.test(name) ? join(config.uploadsDir, name) : null;
}

/** A fresh upload file name. */
const newUploadName = (): string => `reference-${Date.now()}-${randomBytes(8).toString('hex')}.upload`;

/** Deletes an upload (missing files are fine). */
export async function removeUpload(config: Config, file: string): Promise<void> {
  const path = uploadPath(config, file);
  if (path) await rm(path, { force: true });
}

/** A received multipart import: the stored file (name in the uploads dir) and the text fields. */
export interface ReceivedUpload {
  file: string | null;
  originalName: string | null;
  bytes: number;
  fields: Record<string, string>;
}

/**
 * Streams a multipart request to disk: one `file` part (any size up to
 * `REFERENCE_LIMITS.uploadBytes`, else 413 and nothing kept) and up to ten text fields, in any order.
 */
export async function receiveReferenceUpload(req: FastifyRequest, config: Config): Promise<ReceivedUpload> {
  await mkdir(config.uploadsDir, { recursive: true });
  const limit = REFERENCE_LIMITS.uploadBytes;
  const out: ReceivedUpload = { file: null, originalName: null, bytes: 0, fields: {} };
  try {
    const parts = req.parts({
      limits: { fileSize: limit + 1, files: 1, fields: MAX_FIELDS, fieldSize: MAX_FIELD_BYTES },
    });
    for await (const part of parts) {
      if (part.type === 'file') {
        if (part.fieldname !== 'file') {
          part.file.resume();
          throw badRequest('Send the PGN in the multipart field "file"');
        }
        const name = newUploadName();
        out.file = name;
        out.originalName = part.filename || null;
        let bytes = 0;
        const counter = new Transform({
          transform(chunk: Buffer, _enc, cb) {
            bytes += chunk.byteLength;
            if (bytes > limit) cb(new SizeLimitError('The upload', limit));
            else cb(null, chunk);
          },
        });
        await pipeline(part.file, counter, createWriteStream(join(config.uploadsDir, name), { flags: 'wx' }));
        if (part.file.truncated) throw new SizeLimitError('The upload', limit);
        out.bytes = bytes;
      } else {
        if (part.valueTruncated) throw badRequest(`Field ${part.fieldname} is too long`);
        out.fields[part.fieldname] = typeof part.value === 'string' ? part.value : String(part.value);
      }
    }
  } catch (e) {
    if (out.file) await removeUpload(config, out.file);
    if (e instanceof HttpError) throw e;
    const code = (e as { code?: string }).code ?? '';
    if (code === 'FST_REQ_FILE_TOO_LARGE') throw new SizeLimitError('The upload', limit);
    if (code === 'FST_FILES_LIMIT') throw badRequest('Send exactly one file');
    if (code === 'FST_FIELDS_LIMIT' || code === 'FST_PARTS_LIMIT') throw badRequest('Too many form fields');
    // Other plugin errors and busboy's parse errors are the client's malformed body or abort.
    if (code.startsWith('FST_') || /multipart|boundary|end of form|part header|terminated early/i.test((e as Error).message ?? '')) {
      throw badRequest(`Malformed upload: ${(e as Error).message}`);
    }
    throw e;
  }
  if (out.file && out.bytes === 0) {
    await removeUpload(config, out.file);
    throw badRequest('The uploaded file is empty');
  }
  return out;
}

/**
 * Deletes reference uploads older than `minAgeMs` that no queued or running 'referenceImport' job
 * names (left behind by cancelled jobs or crashes). Returns how many were removed.
 */
export async function sweepReferenceUploads(db: Db, config: Config, minAgeMs = 60 * 60 * 1000): Promise<number> {
  let names: string[];
  try {
    names = (await readdir(config.uploadsDir)).filter(n => UPLOAD_NAME_RE.test(n));
  } catch {
    return 0;
  }
  if (names.length === 0) return 0;
  const active = new Set(
    db
      .all<{ file: string | null }>(
        `SELECT json_extract(payload_json, '$.file') AS file FROM jobs
          WHERE kind = 'referenceImport' AND status IN ('queued', 'running')`,
      )
      .map(r => r.file)
      .filter((f): f is string => typeof f === 'string'),
  );
  const now = Date.now();
  let removed = 0;
  for (const name of names) {
    if (active.has(name)) continue;
    const path = join(config.uploadsDir, name);
    try {
      if (now - (await stat(path)).mtimeMs < minAgeMs) continue;
      await rm(path, { force: true });
      removed++;
    } catch {
      // vanished meanwhile
    }
  }
  return removed;
}
