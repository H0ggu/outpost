/**
 * Shared plumbing of the Lichess and Chess.com importers (PLAN §7): source rows, a streaming
 * NDJSON reader and a JSON reader with a body deadline (both turn broken connections into
 * retryable `UpstreamError`s), the batched game importer, country normalisation and the
 * `players_cache` writer.
 */
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import type { EpochMs, Id, JobProgress, SourceKind, Title } from '@outpost/shared/api';
import { isTitle } from '@outpost/shared/chess';
import { insertGame, InvalidGameError, type NormalizedGame } from '../chess/store.ts';
import type { Db } from '../db/index.ts';
import { UpstreamError } from '../http/upstream.ts';
import type { JobContext } from '../jobs/handlers.ts';

/** A `sources` row. */
export interface SourceRow {
  id: Id;
  kind: SourceKind;
  key: string;
  display_name: string;
  site_user_id: string | null;
  title: string | null;
  country: string | null;
  database_id: Id | null;
  profile_json: string | null;
  sync_state_json: string | null;
  last_synced_at: EpochMs | null;
  last_sync_error: string | null;
  created_at: EpochMs;
}

/** A source by id, or undefined. */
export function loadSource(db: Db, id: Id): SourceRow | undefined {
  return db.get<SourceRow>(
    `SELECT id, kind, key, display_name, site_user_id, title, country, database_id, profile_json, sync_state_json,
            last_synced_at, last_sync_error, created_at
       FROM sources WHERE id = ?`,
    [id],
  );
}

/**
 * A sync failure that retrying won't fix (unknown or closed account, invalid username). The
 * message is stored in `sources.last_sync_error` and the job ends in `error`.
 */
export class SyncError extends Error {
  override name = 'SyncError';
}

/** Records a failed sync on the source (kept until the next successful one). */
export function recordSyncError(db: Db, sourceId: Id, message: string): void {
  db.run('UPDATE sources SET last_sync_error = ? WHERE id = ?', [message.slice(0, 500), sourceId]);
}

/** Saves the importer cursor (`sources.sync_state_json`). */
export function saveSyncState(db: Db, sourceId: Id, state: unknown): void {
  db.run('UPDATE sources SET sync_state_json = ? WHERE id = ?', [JSON.stringify(state), sourceId]);
}

/** Marks a sync finished: cursor, time, and the warning to keep (null clears the last error). */
export function finishSync(db: Db, sourceId: Id, state: unknown, warning: string | null, now: EpochMs): void {
  db.run('UPDATE sources SET sync_state_json = ?, last_synced_at = ?, last_sync_error = ? WHERE id = ?', [
    JSON.stringify(state),
    now,
    warning,
    sourceId,
  ]);
}

/** Parses a JSON column into an object, or null. */
export function parseJsonObject<T extends object>(json: string | null | undefined): Partial<T> | null {
  if (!json) return null;
  try {
    const v: unknown = JSON.parse(json);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Partial<T>) : null;
  } catch {
    return null;
  }
}

/** A title the site reported, if Outpost knows it. */
export const titleOrNull = (v: unknown): Title | null => (isTitle(v) ? v : null);

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Idle time allowed between two chunks of a streamed body before the stream counts as broken. */
export const STREAM_IDLE_TIMEOUT_MS = 90_000;
/** Time allowed to read a whole JSON body (Chess.com months are a few MB). */
export const BODY_TIMEOUT_MS = 120_000;

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  host: string,
  signal: AbortSignal,
  idleMs: number,
): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new UpstreamError('timeout', host, `${host} stopped sending data for ${Math.round(idleMs / 1000)} s`)),
          idleMs,
        );
      }),
    ]);
  } catch (e) {
    if (signal.aborted) throw signal.reason ?? e;
    if (e instanceof UpstreamError) throw e;
    throw new UpstreamError('network', host, `The connection to ${host} broke: ${errorText(e)}`, { cause: e });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Streams the lines of an NDJSON response as parsed values (empty keep-alive lines skipped).
 * Stops and closes the connection when the consumer stops early. A broken connection, a stall or a
 * malformed line throws a retryable `UpstreamError`.
 */
export async function* readNdjson<T>(
  res: Response,
  host: string,
  signal: AbortSignal,
  idleMs: number = STREAM_IDLE_TIMEOUT_MS,
): AsyncGenerator<T> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let finished = false;
  const parse = (line: string): T => {
    try {
      return JSON.parse(line) as T;
    } catch (e) {
      throw new UpstreamError('network', host, `${host} sent a malformed NDJSON line (truncated stream?)`, { cause: e });
    }
  };
  try {
    for (;;) {
      const { done, value } = await readChunk(reader, host, signal, idleMs);
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      if (!buf.includes('\n')) continue;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const raw of lines) {
        const line = raw.trim();
        if (line) yield parse(line);
      }
    }
    finished = true;
    buf += decoder.decode();
    const last = buf.trim();
    if (last) yield parse(last);
  } finally {
    if (!finished) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/**
 * Reads a JSON body within `timeoutMs` (the upstream client's timeout only covers the headers).
 * A broken connection or a stall throws a retryable `UpstreamError`; invalid JSON throws a 502-ish
 * `UpstreamError('status')` that is retried too (Chess.com occasionally serves error pages).
 */
export async function readJsonBody<T>(res: Response, host: string, signal: AbortSignal, timeoutMs: number = BODY_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let text: string;
  try {
    text = await Promise.race([
      res.text(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new UpstreamError('timeout', host, `${host} took more than ${timeoutMs / 1000} s to send a response`)), timeoutMs);
      }),
    ]);
  } catch (e) {
    void res.body?.cancel().catch(() => {});
    if (signal.aborted) throw signal.reason ?? e;
    if (e instanceof UpstreamError) throw e;
    throw new UpstreamError('network', host, `The connection to ${host} broke: ${errorText(e)}`, { cause: e });
  } finally {
    clearTimeout(timer);
  }
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw new UpstreamError('status', host, `${host} sent a response that is not JSON`, { status: 503, cause: e });
  }
}

/** Start of the first import window: `months` calendar months before `now` (same day and time), or null for everything. */
export function initialCutoff(now: EpochMs, months: number): EpochMs | null {
  if (months <= 0) return null;
  const d = new Date(now);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return Date.UTC(
    target.getUTCFullYear(),
    target.getUTCMonth(),
    Math.min(d.getUTCDate(), lastDay),
    d.getUTCHours(),
    d.getUTCMinutes(),
    d.getUTCSeconds(),
    d.getUTCMilliseconds(),
  );
}

/** Lichess sub-national flags (GB-ENG, ES-CT …) count as their country; `_earth`, `_pirate` … as none. */
export function countryFromLichessFlag(flag: unknown): string | null {
  if (typeof flag !== 'string') return null;
  const m = /^([A-Z]{2})(?:-[A-Z0-9]{1,4})?$/.exec(flag.trim());
  return m ? m[1]! : null;
}

/**
 * Chess.com country codes → ISO 3166-1 alpha-2 (`XK` Kosovo is kept: the world map uses it).
 * Chess.com's user-assigned codes: XA Canary Islands, XB Basque Country, XC Catalonia, XG Galicia
 * (→ ES), XE England, XS Scotland, XW Wales (→ GB), XP Palestine (→ PS), XX International (none).
 */
const CHESSCOM_X_CODES: Readonly<Record<string, string | null>> = {
  XA: 'ES',
  XB: 'ES',
  XC: 'ES',
  XG: 'ES',
  XE: 'GB',
  XS: 'GB',
  XW: 'GB',
  XP: 'PS',
  XK: 'XK',
  XX: null,
};

/** The code at the end of a Chess.com country URL (`…/pub/country/US`), uppercase, or null. */
export function chesscomCountryCode(countryUrl: unknown): string | null {
  if (typeof countryUrl !== 'string') return null;
  const m = /\/country\/([A-Za-z]{2})\/?$/.exec(countryUrl.trim());
  return m ? m[1]!.toUpperCase() : null;
}

/** ISO country of a Chess.com country URL or code. */
export function countryFromChesscom(countryUrlOrCode: unknown): string | null {
  const code =
    typeof countryUrlOrCode === 'string' && /^[A-Za-z]{2}$/.test(countryUrlOrCode)
      ? countryUrlOrCode.toUpperCase()
      : chesscomCountryCode(countryUrlOrCode);
  if (!code) return null;
  return code in CHESSCOM_X_CODES ? CHESSCOM_X_CODES[code]! : code;
}

/** Writes what Outpost knows about a player into `players_cache` (fetched now). */
export function upsertPlayerCache(
  db: Db,
  kind: 'lichess' | 'chesscom',
  key: string,
  info: { country: string | null; title: Title | null; name: string | null },
  now: EpochMs,
): void {
  db.run(
    `INSERT INTO players_cache (kind, key, country, title, name, fetched_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (kind, key) DO UPDATE SET country = excluded.country, title = excluded.title,
       name = COALESCE(excluded.name, players_cache.name), fetched_at = excluded.fetched_at`,
    [kind, key, info.country, info.title, info.name, now],
  );
}

/** Import counters shown in `JobProgress.counts`. */
export interface ImportCounts {
  imported: number;
  duplicates: number;
  skipped: number;
  [key: string]: number;
}

/**
 * Buffers games and stores them with `insertGame` in short transactions (the API stays
 * responsive between batches). A flush can carry extra writes — the importer's cursor — in the
 * same transaction, so an interrupted sync resumes exactly after the last stored batch.
 */
export class GameImporter {
  readonly counts: ImportCounts = { imported: 0, duplicates: 0, skipped: 0 };
  #pending: NormalizedGame[] = [];
  readonly #ctx: JobContext;
  readonly #sourceId: Id;
  readonly #batchSize: number;

  constructor(ctx: JobContext, sourceId: Id, batchSize = 100) {
    this.#ctx = ctx;
    this.#sourceId = sourceId;
    this.#batchSize = batchSize;
  }

  /** Games waiting for the next flush. */
  get buffered(): number {
    return this.#pending.length;
  }

  /** Buffers a game; true when the batch is full and should be flushed. */
  add(game: NormalizedGame): boolean {
    this.#pending.push(game);
    return this.#pending.length >= this.#batchSize;
  }

  /** Counts a game that was not imported. */
  skip(): void {
    this.counts.skipped++;
  }

  /** Stores the buffered games plus `extra` writes in one transaction, then yields to the event loop. */
  async flush(extra?: () => void): Promise<void> {
    const batch = this.#pending;
    this.#pending = [];
    const { db, log } = this.#ctx;
    db.tx(() => {
      for (const g of batch) {
        try {
          const r = insertGame(db, g, { sourceId: this.#sourceId });
          if (r.inserted) this.counts.imported++;
          else this.counts.duplicates++;
        } catch (e) {
          if (!(e instanceof InvalidGameError)) throw e;
          this.counts.skipped++;
          log.warn({ originId: g.originId, err: e.message }, 'skipped a game with an illegal move');
        }
      }
      extra?.();
    });
    await yieldToEventLoop();
  }

  /** Reports progress (the worker throttles the writes). */
  report(done: number, total: number | null, message: string): void {
    const p: JobProgress = { done, total, message, counts: { ...this.counts } };
    this.#ctx.progress(p);
  }
}

/** Throws the abort reason when the job was cancelled or the server is stopping. */
export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error('aborted');
}
