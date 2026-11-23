/**
 * Stockfish NNUE networks for lila's ceval (PLAN §6 `/assets/lifat/nnue/:name`, §8).
 *
 * lila's stockfish-web engine loads `/assets/lifat/nnue/<name>`; Outpost downloads each network
 * once from tests.stockfishchess.org/api/nn/<name> (through `app.upstream`) into
 * `config.nnueDir` and serves it from disk afterwards:
 * - names must match `^nn-[0-9a-f]{12}\.nnue$`; Stockfish names a network after the first 12 hex
 *   digits of its SHA-256, so every download is verified against its name;
 * - the body streams to a temp file in the same directory while hashing, then is renamed into
 *   place atomically (a crash never leaves a half-written network under its real name);
 * - concurrent requests for the same name share one download; a failed name is not retried for a
 *   short while (so a 404 isn't re-requested on every page load);
 * - size and count limits bound the disk used.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { UPSTREAM, type Upstream } from '../http/upstream.ts';

/** Allowed network names. */
export const NNUE_NAME_RE = /^nn-[0-9a-f]{12}\.nnue$/;
/** Largest network accepted (Stockfish's big nets are ~110 MB). */
export const MAX_NNUE_BYTES = 256 * 1024 * 1024;
/** Most networks kept on disk. */
export const MAX_NNUE_FILES = 16;
/** How long a failed download is remembered. */
export const NNUE_FAILURE_TTL_MS = 10 * 60_000;
/** Time allowed until the upstream's headers arrive, and for the whole download. */
export const NNUE_HEADERS_TIMEOUT_MS = 30_000;
export const NNUE_DOWNLOAD_TIMEOUT_MS = 15 * 60_000;

/** Why a network is unavailable. */
export type NnueFailure = 'not_found' | 'hash_mismatch' | 'too_large' | 'quota' | 'upstream';

/** A network could not be provided. */
export class NnueError extends Error {
  override name = 'NnueError';
  readonly reason: NnueFailure;
  constructor(reason: NnueFailure, message: string, opts: { cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.reason = reason;
  }
}

/** A network on disk. */
export interface NnueFile {
  path: string;
  size: number;
  mtimeMs: number;
}

/** The NNUE cache of one app. */
export interface NnueStore {
  /** The cached file, or null when it isn't downloaded yet. */
  cached(name: string): Promise<NnueFile | null>;
  /** The file, downloading it first if needed (shared between concurrent callers). */
  ensure(name: string): Promise<NnueFile>;
  /** Names currently downloading. */
  inFlight(): string[];
}

export function createNnueStore(deps: {
  dir: string;
  upstream: Upstream;
  now?: () => number;
  maxBytes?: number;
  maxFiles?: number;
  log?: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
}): NnueStore {
  const now = deps.now ?? Date.now;
  const maxBytes = deps.maxBytes ?? MAX_NNUE_BYTES;
  const maxFiles = deps.maxFiles ?? MAX_NNUE_FILES;
  const downloads = new Map<string, Promise<NnueFile>>();
  const failures = new Map<string, { at: number; error: NnueError }>();

  const check = (name: string): void => {
    if (!NNUE_NAME_RE.test(name)) throw new NnueError('not_found', `Not an NNUE network name: ${name}`);
  };

  const cached = async (name: string): Promise<NnueFile | null> => {
    check(name);
    const path = join(deps.dir, name);
    try {
      const s = await stat(path);
      return s.isFile() ? { path, size: s.size, mtimeMs: s.mtimeMs } : null;
    } catch {
      return null;
    }
  };

  const download = async (name: string): Promise<NnueFile> => {
    await mkdir(deps.dir, { recursive: true });
    const existing = (await readdir(deps.dir)).filter(f => NNUE_NAME_RE.test(f));
    if (existing.length >= maxFiles) throw new NnueError('quota', `At most ${maxFiles} NNUE networks are kept`);

    const expected = name.slice(3, 15);
    const tmp = join(deps.dir, `.${name}.${randomBytes(6).toString('hex')}.tmp`);
    const signal = AbortSignal.timeout(NNUE_DOWNLOAD_TIMEOUT_MS);
    let res: Response;
    try {
      res = await deps.upstream.fetch(`${UPSTREAM.nnue}/api/nn/${name}`, {
        timeoutMs: NNUE_HEADERS_TIMEOUT_MS,
        signal,
        allowStatuses: [404],
        headers: { accept: 'application/octet-stream' },
      });
    } catch (e) {
      throw new NnueError('upstream', `Could not download ${name}: ${(e as Error).message}`, { cause: e });
    }
    if (res.status === 404) {
      void res.body?.cancel().catch(() => {});
      throw new NnueError('not_found', `${name} is not on tests.stockfishchess.org`);
    }
    const declared = Number(res.headers.get('content-length') ?? 'NaN');
    if (Number.isFinite(declared) && declared > maxBytes) {
      void res.body?.cancel().catch(() => {});
      throw new NnueError('too_large', `${name} is ${declared} bytes (limit ${maxBytes})`);
    }
    if (!res.body) throw new NnueError('upstream', `Empty response for ${name}`);

    const hash = createHash('sha256');
    let size = 0;
    const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream<Uint8Array>);
    try {
      await pipeline(
        body,
        async function* (source: AsyncIterable<Buffer>) {
          for await (const chunk of source) {
            size += chunk.length;
            if (size > maxBytes) throw new NnueError('too_large', `${name} exceeds ${maxBytes} bytes`);
            hash.update(chunk);
            yield chunk;
          }
        },
        createWriteStream(tmp, { flags: 'wx', mode: 0o644 }),
      );
      const digest = hash.digest('hex');
      if (!digest.startsWith(expected)) {
        throw new NnueError('hash_mismatch', `${name}: downloaded file has SHA-256 ${digest.slice(0, 12)}…, expected ${expected}…`);
      }
      await rename(tmp, join(deps.dir, name));
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => {});
      if (e instanceof NnueError) throw e;
      throw new NnueError('upstream', `Download of ${name} failed: ${(e as Error).message}`, { cause: e });
    }
    deps.log?.info({ name, size }, 'nnue: downloaded and verified');
    const file = await cached(name);
    if (!file) throw new NnueError('upstream', `${name} vanished after download`);
    return file;
  };

  return {
    cached,
    async ensure(name) {
      const have = await cached(name);
      if (have) return have;
      const failed = failures.get(name);
      if (failed && now() - failed.at < NNUE_FAILURE_TTL_MS) throw failed.error;
      let p = downloads.get(name);
      if (!p) {
        p = download(name).then(
          file => {
            failures.delete(name);
            return file;
          },
          (e: unknown) => {
            const err = e instanceof NnueError ? e : new NnueError('upstream', String(e), { cause: e });
            if (err.reason !== 'quota') failures.set(name, { at: now(), error: err });
            deps.log?.warn({ name, reason: err.reason, err }, 'nnue: download failed');
            throw err;
          },
        );
        const cleanup = (): void => {
          downloads.delete(name);
        };
        p.then(cleanup, cleanup);
        downloads.set(name, p);
      }
      return p;
    },
    inFlight: () => [...downloads.keys()],
  };
}

/** Parses a single-range `Range: bytes=…` header against a size. null = no (usable) range; 'unsatisfiable' → 416. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start: number;
  let end: number;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (suffix === 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}
