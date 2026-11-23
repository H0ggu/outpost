/**
 * Job handlers of the reference module (registered from routes/reference.ts):
 * - 'broadcastMonth': one database.lichess.org month (`.pgn.zst`, streamed and decompressed);
 * - 'referenceImport': an uploaded file (deleted afterwards) or an https URL (size-capped);
 * - 'broadcastRound': one Lichess broadcast round through the API (token required).
 *
 * Every download goes through `ctx.upstream` with `ctx.signal`, so cancelling a job stops it.
 * Handlers capture nothing from an app (the registry is process-wide).
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { BROADCAST_ID_RE, fetchRound, federationsOf, roundPgnUrl } from '../broadcasts/lichess.ts';
import { LICHESS_TOKEN_HOSTS, UpstreamError, type UpstreamInit } from '../http/upstream.ts';
import type { JobContext } from '../jobs/index.ts';
import { markBroadcastData, requireReferenceDatabase } from './databases.ts';
import { importReferencePgn, type ImportResult } from './importer.ts';
import { broadcastMonthProblem, broadcastMonthUrl, recordMonth } from './months.ts';
import { updateFederations } from './players.ts';
import { bodyChunks, countBytes, decompressAuto, formatBytes, REFERENCE_LIMITS, SizeLimitError } from './stream.ts';
import { removeUpload, uploadPath } from './upload.ts';
import { importUrlProblem } from './urls.ts';

/** Time allowed for an upstream download to start answering. */
const DOWNLOAD_TIMEOUT_MS = 60_000;
/** A download that sends nothing for this long is aborted (a retryable network error). */
export const DOWNLOAD_IDLE_MS = { value: 120_000 };

const percent = (done: number, total: number | null): string | null =>
  total ? `${Math.min(100, Math.floor((done * 100) / total))}% of ${formatBytes(total)}` : null;

const contentLength = (res: Response): number | null => {
  const n = Number(res.headers.get('content-length'));
  return Number.isFinite(n) && n > 0 ? n : null;
};

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A streaming download: the response, its body as size-capped chunks, and how much was read. */
interface Download {
  res: Response;
  chunks: AsyncIterable<Uint8Array>;
  read(): number;
  total: number | null;
}

/**
 * GETs `url` through `ctx.upstream` and streams the body, capped at `max` bytes. The body must keep
 * flowing: after `DOWNLOAD_IDLE_MS` without data the request is aborted with a retryable
 * `UpstreamError('network')`. Cancelling the job aborts it too. `open` runs on the response first
 * (status checks) and may return a replacement error.
 */
async function download(
  ctx: JobContext,
  url: string | URL,
  init: Omit<UpstreamInit, 'signal'> & { max: number; what: string },
): Promise<Download> {
  const host = new URL(url).host;
  const idle = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const arm = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => idle.abort(), DOWNLOAD_IDLE_MS.value);
    timer.unref();
  };
  const { max, what, ...upstreamInit } = init;
  const res = await ctx.upstream.fetch(url, { timeoutMs: DOWNLOAD_TIMEOUT_MS, ...upstreamInit, signal: AbortSignal.any([ctx.signal, idle.signal]) });
  let read = 0;
  async function* chunks(): AsyncGenerator<Uint8Array> {
    arm();
    try {
      yield* countBytes(bodyChunks(res.body), {
        max,
        what,
        onBytes: n => {
          read = n;
          arm();
        },
      });
    } catch (e) {
      if (idle.signal.aborted && !ctx.signal.aborted) {
        throw new UpstreamError('network', host, `${host} sent no data for ${Math.round(DOWNLOAD_IDLE_MS.value / 1000)} s`, { cause: e });
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
  return { res, chunks: chunks(), read: () => read, total: contentLength(res) };
}

/** Fails when the target database is gone (deleted while the job waited). */
function targetDatabase(ctx: JobContext, databaseId: number): void {
  try {
    requireReferenceDatabase(ctx.db, databaseId);
  } catch {
    throw new Error(`Reference database ${databaseId} no longer exists`);
  }
}

/** 'broadcastMonth': stream one month's `.pgn.zst` from database.lichess.org into the reference DB. */
export async function runBroadcastMonth(ctx: JobContext<'broadcastMonth'>): Promise<void> {
  const { databaseId, month } = ctx.job.payload;
  const problem = broadcastMonthProblem(month);
  if (problem) throw new Error(problem);
  targetDatabase(ctx, databaseId);
  markBroadcastData(ctx.db, databaseId);
  let result: ImportResult;
  try {
    const dl = await download(ctx, broadcastMonthUrl(month), {
      allowStatuses: [404],
      max: REFERENCE_LIMITS.downloadBytes,
      what: `The ${month} download`,
    });
    if (dl.res.status === 404) {
      void dl.res.body?.cancel().catch(() => {});
      throw new Error(`${month} is not published on database.lichess.org yet`);
    }
    result = await importReferencePgn(ctx, decompressAuto(dl.chunks), {
      databaseId,
      label: month,
      note: () => percent(dl.read(), dl.total),
    });
  } catch (e) {
    if (!ctx.signal.aborted) recordMonth(ctx.db, databaseId, month, { ok: false, error: errorMessage(e) });
    throw e;
  }
  recordMonth(ctx.db, databaseId, month, { ok: true, ...result.counts });
}

/** 'referenceImport': an uploaded file or an https URL into a reference DB. */
export async function runReferenceImport(ctx: JobContext<'referenceImport'>): Promise<void> {
  const { databaseId, file, url } = ctx.job.payload;
  targetDatabase(ctx, databaseId);
  if (file) {
    await importUploadedFile(ctx, databaseId, file);
    return;
  }
  if (url) {
    await importUrl(ctx, databaseId, url);
    return;
  }
  throw new Error('Nothing to import: the job has neither a file nor a url');
}

async function importUploadedFile(ctx: JobContext<'referenceImport'>, databaseId: number, file: string): Promise<void> {
  const path = uploadPath(ctx.config, file);
  if (!path) throw new Error('Invalid upload file name');
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    throw new Error('The uploaded file is gone (the job was cancelled or the data directory changed); upload it again');
  }
  try {
    let read = 0;
    const bytes = countBytes(createReadStream(path, { signal: ctx.signal }) as AsyncIterable<Uint8Array>, {
      max: REFERENCE_LIMITS.uploadBytes,
      what: 'The upload',
      onBytes: n => (read = n),
    });
    await importReferencePgn(ctx, decompressAuto(bytes), {
      databaseId,
      label: 'Upload',
      note: () => percent(read, size),
    });
  } catch (e) {
    // Cancel / shutdown keeps the file for a re-queued run (the sweeper removes orphans); any
    // other failure is final for a file import.
    if (!ctx.signal.aborted) await removeUpload(ctx.config, file);
    throw e;
  }
  await removeUpload(ctx.config, file);
}

async function importUrl(ctx: JobContext<'referenceImport'>, databaseId: number, url: string): Promise<void> {
  const problem = importUrlProblem(url);
  if (problem) throw new Error(problem);
  const target = new URL(url);
  const dl = await download(ctx, target, {
    // The admin's token helps with Lichess's own exports (broadcast PGNs, studies); never sent elsewhere.
    ...(LICHESS_TOKEN_HOSTS.has(target.hostname) ? { auth: 'optional' as const } : {}),
    max: REFERENCE_LIMITS.downloadBytes,
    what: 'The download',
  });
  if (dl.res.url && !dl.res.url.startsWith('https://')) {
    void dl.res.body?.cancel().catch(() => {});
    throw new Error('The download was redirected to a non-https address');
  }
  if (dl.total !== null && dl.total > REFERENCE_LIMITS.downloadBytes) {
    void dl.res.body?.cancel().catch(() => {});
    throw new SizeLimitError('The download', REFERENCE_LIMITS.downloadBytes);
  }
  await importReferencePgn(ctx, decompressAuto(dl.chunks), {
    databaseId,
    label: target.hostname,
    note: () => percent(dl.read(), dl.total),
  });
}

/** 'broadcastRound': one Lichess broadcast round (JSON for the hints, then its PGN). */
export async function runBroadcastRound(ctx: JobContext<'broadcastRound'>): Promise<void> {
  const { databaseId, roundId } = ctx.job.payload;
  if (!BROADCAST_ID_RE.test(roundId)) throw new Error(`Invalid broadcast round id ${JSON.stringify(roundId)}`);
  targetDatabase(ctx, databaseId);
  markBroadcastData(ctx.db, databaseId);
  let info: Awaited<ReturnType<typeof fetchRound>> | null = null;
  try {
    info = await fetchRound(ctx.upstream, roundId, ctx.signal);
    const federations = federationsOf(info);
    const dl = await download(ctx, roundPgnUrl(roundId), {
      auth: 'required',
      headers: { accept: 'application/x-chess-pgn' },
      allowStatuses: [404],
      max: REFERENCE_LIMITS.downloadBytes,
      what: 'The round PGN',
    });
    if (dl.res.status === 404) {
      void dl.res.body?.cancel().catch(() => {});
      throw new Error('Broadcast round not found');
    }
    const result = await importReferencePgn(ctx, dl.chunks, {
      databaseId,
      label: `${info.tour.name} · ${info.round.name}`,
      round: {
        tourName: info.tour.name,
        startsAt: info.round.startsAt ?? null,
        fideTC: typeof info.tour.info?.fideTC === 'string' ? info.tour.info.fideTC : null,
        federations,
      },
    });
    updateFederations(ctx.db, federations);
    recordRound(ctx, info, {
      status: info.round.finished ? 'imported' : 'partial',
      games: result.counts.imported + result.counts.duplicates,
      error: null,
    });
  } catch (e) {
    if (!ctx.signal.aborted) recordRound(ctx, info, { status: 'error', games: 0, error: errorMessage(e) });
    throw e;
  }
}

function recordRound(
  ctx: JobContext<'broadcastRound'>,
  info: Awaited<ReturnType<typeof fetchRound>> | null,
  r: { status: 'imported' | 'partial' | 'error'; games: number; error: string | null },
): void {
  const { databaseId, roundId } = ctx.job.payload;
  ctx.db.run(
    `INSERT INTO reference_broadcast_rounds (database_id, round_id, tour_id, tour_name, round_name, status, games, updated_at, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (database_id, round_id) DO UPDATE SET
       tour_id = COALESCE(excluded.tour_id, tour_id), tour_name = COALESCE(excluded.tour_name, tour_name),
       round_name = COALESCE(excluded.round_name, round_name), status = excluded.status,
       games = CASE WHEN excluded.status = 'error' THEN games ELSE excluded.games END,
       updated_at = excluded.updated_at, error = excluded.error`,
    [
      databaseId,
      roundId,
      info?.tour.id ?? null,
      info?.tour.name ?? null,
      info?.round.name ?? null,
      r.status,
      r.games,
      Date.now(),
      r.error?.slice(0, 1000) ?? null,
    ],
  );
}

/** Registers nothing itself: the route plugin passes these to `registerJobHandler`. */
export const REFERENCE_JOB_HANDLERS = {
  broadcastMonth: runBroadcastMonth,
  referenceImport: runReferenceImport,
  broadcastRound: runBroadcastRound,
} satisfies { [K in 'broadcastMonth' | 'referenceImport' | 'broadcastRound']: (ctx: JobContext<K>) => Promise<void> };
