/**
 * Byte streams for reference imports: size caps, progress, and transparent zstd / gzip
 * decompression (node:zlib) chosen by magic bytes, so `.pgn`, `.pgn.zst` and `.pgn.gz` uploads and
 * downloads all feed `parsePgnGames` the same way.
 */
import { pipeline, Readable } from 'node:stream';
import { createGunzip, createZstdDecompress } from 'node:zlib';
import { HttpError } from '../http/errors.ts';

const GB = 1024 ** 3;

/** Size limits of reference imports (mutable for tests). */
export const REFERENCE_LIMITS = {
  /** Multipart upload streamed to disk (PLAN §10: 2 GB). */
  uploadBytes: 2 * GB,
  /** `{url}` downloads (compressed size as transferred). */
  downloadBytes: 2 * GB,
  /** Decompressed PGN from one file (guards against decompression bombs). */
  decompressedBytes: 32 * GB,
};

/** Too much data: becomes a job error (or 413 in a route). */
export class SizeLimitError extends HttpError {
  constructor(what: string, limit: number) {
    super(413, 'payload_too_large', `${what} is larger than ${formatBytes(limit)}`);
  }
}

/** Unsupported container (zip, bzip2…). */
export class UnsupportedFormatError extends Error {
  override name = 'UnsupportedFormatError';
}

/** `1.5 GB`, `512 MB`, `12 kB`. */
export function formatBytes(n: number): string {
  if (n >= GB) return `${(n / GB).toFixed(n % GB === 0 ? 0 : 1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} kB`;
  return `${n} B`;
}

/** Yields the chunks of `src`, reporting the running byte count and failing past `max`. */
export async function* countBytes(
  src: AsyncIterable<Uint8Array>,
  opts: { max: number; what: string; onBytes?: (total: number) => void },
): AsyncGenerator<Uint8Array> {
  let total = 0;
  for await (const chunk of src) {
    total += chunk.byteLength;
    if (total > opts.max) throw new SizeLimitError(opts.what, opts.max);
    opts.onBytes?.(total);
    yield chunk;
  }
}

/** Compression of a stream, from its first bytes. */
export type Compression = 'zstd' | 'gzip' | 'none';

/**
 * Detects zstd (frame magic 28 B5 2F FD, or a skippable frame 5x 2A 4D 18 as written by seekable /
 * multi-threaded encoders: database.lichess.org files start with one) and gzip (1F 8B); throws for
 * zip and bzip2; anything else is plain text.
 */
export function detectCompression(head: Uint8Array): Compression {
  if (head.length >= 4 && head[0] === 0x28 && head[1] === 0xb5 && head[2] === 0x2f && head[3] === 0xfd) return 'zstd';
  if (head.length >= 4 && (head[0]! & 0xf0) === 0x50 && head[1] === 0x2a && head[2] === 0x4d && head[3] === 0x18) return 'zstd';
  if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) return 'gzip';
  if (head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) {
    throw new UnsupportedFormatError('ZIP archives are not supported: extract the PGN (or recompress it as .zst or .gz)');
  }
  if (head.length >= 3 && head[0] === 0x42 && head[1] === 0x5a && head[2] === 0x68) {
    throw new UnsupportedFormatError('bzip2 files are not supported: recompress the PGN as .zst or .gz');
  }
  return 'none';
}

/**
 * Decompresses `src` when it is zstd or gzip (by magic bytes), passing plain text through.
 * Errors and early exits tear the decompressor down (stream.pipeline).
 */
export async function* decompressAuto(src: AsyncIterable<Uint8Array>, opts: { maxOutput?: number } = {}): AsyncGenerator<Uint8Array> {
  const it = src[Symbol.asyncIterator]();
  const head: Uint8Array[] = [];
  let headLength = 0;
  let done = false;
  while (headLength < 4) {
    const r = await it.next();
    if (r.done) {
      done = true;
      break;
    }
    head.push(r.value);
    headLength += r.value.byteLength;
  }
  const first = Buffer.concat(head);
  // Closes the source on every exit (not awaited: a pending read finishes, or fails on the
  // caller's abort signal, on its own time).
  const closeSource = (): void => void Promise.resolve(it.return?.()).catch(() => {});
  let compression: Compression;
  try {
    compression = detectCompression(first);
  } catch (e) {
    closeSource();
    throw e;
  }
  async function* replay(): AsyncGenerator<Uint8Array> {
    try {
      if (first.byteLength) yield first;
      if (done) return;
      for (;;) {
        const r = await it.next();
        if (r.done) return;
        yield r.value;
      }
    } finally {
      closeSource();
    }
  }
  const maxOutput = opts.maxOutput ?? REFERENCE_LIMITS.decompressedBytes;
  if (compression === 'none') {
    yield* countBytes(replay(), { max: maxOutput, what: 'The PGN' });
    return;
  }
  const decoder = compression === 'zstd' ? createZstdDecompress() : createGunzip();
  const out = pipeline(Readable.from(replay(), { objectMode: false }), decoder, () => {});
  try {
    yield* countBytes(out as AsyncIterable<Uint8Array>, { max: maxOutput, what: 'The decompressed PGN' });
  } finally {
    decoder.destroy();
    closeSource();
  }
}

/** A fetch body as an async iterable of bytes. */
export function bodyChunks(body: ReadableStream<Uint8Array> | null): AsyncIterable<Uint8Array> {
  if (!body) return (async function* () {})();
  return body as unknown as AsyncIterable<Uint8Array>;
}
