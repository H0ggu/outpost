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
 * - size and count limits bound the disk used: when `maxFiles` networks (counting downloads in
 *   flight) are kept, the least recently used one is evicted to make room, except networks used
 *   within `NNUE_KEEP_RECENT_MS`; new downloads are also capped per hour, so a client asking for
 *   many different networks can't turn the cache into a download loop;
 * - temp files left by a crash or kill mid-download are removed at start (`removeStaleTemps`).
 *
 * "Last used" is the file's atime, set explicitly when a network is served (at most every few
 * minutes per name, so it works on `noatime` mounts too), or its mtime when it was never served.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, utimes } from 'node:fs/promises';
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
/** Networks used this recently are never evicted (a full cache refuses new names instead). */
export const NNUE_KEEP_RECENT_MS = 60 * 60_000;
/** Most new downloads per hour. */
export const MAX_NNUE_DOWNLOADS_PER_HOUR = 8;
/** A served network's "last used" time is written at most this often. */
const TOUCH_EVERY_MS = 5 * 60_000;
/** Temp files of downloads (`.<name>.<random>.tmp`). */
const TEMP_RE = /^\.nn-[0-9a-f]{12}\.nnue\.[0-9a-f]{12}\.tmp$/;
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
  /** Records that a network was served (for least-recently-used eviction). */
  markUsed(name: string): void;
  /** Names currently downloading. */
  inFlight(): string[];
  /** Deletes temp files left by an interrupted download (call once at start); returns how many. */
  removeStaleTemps(): Promise<number>;
}

export function createNnueStore(deps: {
  dir: string;
  upstream: Upstream;
  now?: () => number;
  maxBytes?: number;
  maxFiles?: number;
  maxDownloadsPerHour?: number;
  keepRecentMs?: number;
  log?: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
}): NnueStore {
  const now = deps.now ?? Date.now;
  const maxBytes = deps.maxBytes ?? MAX_NNUE_BYTES;
  const maxFiles = Math.max(1, deps.maxFiles ?? MAX_NNUE_FILES);
  const maxPerHour = deps.maxDownloadsPerHour ?? MAX_NNUE_DOWNLOADS_PER_HOUR;
  const keepRecentMs = deps.keepRecentMs ?? NNUE_KEEP_RECENT_MS;
  const downloads = new Map<string, Promise<NnueFile>>();
  const failures = new Map<string, { at: number; error: NnueError }>();
  /** Start times of downloads in the last hour. */
  const started: number[] = [];
  /** Last use per name in this process (also written to the file's atime, throttled). */
  const lastUsed = new Map<string, number>();
  const touchedAt = new Map<string, number>();
  /** Serialises slot reservations (count + evict) so concurrent downloads of different names can't overshoot. */
  let slotLock: Promise<unknown> = Promise.resolve();

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

  const markUsed = (name: string): void => {
    if (!NNUE_NAME_RE.test(name)) return;
    const t = now();
    lastUsed.set(name, t);
    if (t - (touchedAt.get(name) ?? -Infinity) < TOUCH_EVERY_MS) return;
    touchedAt.set(name, t);
    const path = join(deps.dir, name);
    void stat(path)
      .then(s => utimes(path, new Date(t), s.mtime))
      .catch(() => {});
  };

  /**
   * Makes room for one more network: networks on disk plus other downloads in flight stay within
   * `maxFiles`, evicting the least recently used networks (never one used within `keepRecentMs`).
   */
  const reserveSlot = (name: string): Promise<void> => {
    const run = async (): Promise<void> => {
      await mkdir(deps.dir, { recursive: true });
      const files = (await readdir(deps.dir)).filter(f => NNUE_NAME_RE.test(f) && f !== name);
      const pending = [...downloads.keys()].filter(n => n !== name && !files.includes(n)).length;
      let excess = files.length + pending + 1 - maxFiles;
      if (excess <= 0) return;
      const candidates: Array<{ f: string; used: number }> = [];
      for (const f of files) {
        try {
          const s = await stat(join(deps.dir, f));
          candidates.push({ f, used: Math.max(lastUsed.get(f) ?? 0, s.atimeMs, s.mtimeMs) });
        } catch {
          excess--; // gone meanwhile
        }
      }
      candidates.sort((a, b) => a.used - b.used || (a.f < b.f ? -1 : 1));
      for (const c of candidates) {
        if (excess <= 0) break;
        if (now() - c.used < keepRecentMs) break;
        await rm(join(deps.dir, c.f), { force: true });
        lastUsed.delete(c.f);
        touchedAt.delete(c.f);
        deps.log?.info({ name: c.f, lastUsed: new Date(c.used).toISOString() }, 'nnue: evicted the least recently used network');
        excess--;
      }
      if (excess > 0) {
        throw new NnueError('quota', `At most ${maxFiles} NNUE networks are kept and all of them were used within the last ${Math.round(keepRecentMs / 60_000)} minutes`);
      }
    };
    const p = slotLock.then(run, run);
    slotLock = p.catch(() => {});
    return p;
  };

  /** Downloads started within the last hour (only real ones: a 404 costs no bandwidth). */
  const recentDownloads = (): number => {
    const hourAgo = now() - 60 * 60_000;
    while (started.length && started[0]! <= hourAgo) started.shift();
    return started.length;
  };
  const tooMany = (): NnueError =>
    new NnueError('quota', `At most ${maxPerHour} NNUE networks are downloaded per hour; try again later`);

  const download = async (name: string): Promise<NnueFile> => {
    if (recentDownloads() >= maxPerHour) throw tooMany();

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
    try {
      if (recentDownloads() >= maxPerHour) throw tooMany();
      started.push(now());
      await reserveSlot(name);
    } catch (e) {
      void res.body.cancel().catch(() => {});
      throw e;
    }

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
    markUsed,
    async removeStaleTemps() {
      let names: string[];
      try {
        names = await readdir(deps.dir);
      } catch {
        return 0;
      }
      let removed = 0;
      for (const f of names) {
        if (!TEMP_RE.test(f) || downloads.has(f.slice(1, 21))) continue;
        await rm(join(deps.dir, f), { force: true }).catch(() => {});
        removed++;
      }
      if (removed) deps.log?.info({ removed }, 'nnue: removed temp files of interrupted downloads');
      return removed;
    },
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
