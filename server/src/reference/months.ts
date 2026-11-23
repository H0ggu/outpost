/**
 * database.lichess.org broadcast months (research lichess-api.md §5): validation, the catalogue of
 * published months (`/broadcast/list.txt`, cached), and the import state shown by `GET /api/reference`.
 *
 * Files: `https://database.lichess.org/broadcast/lichess_db_broadcast_YYYY-MM.pgn.zst`, first month
 * 2020-01, each published about ten days after the month ends. Licence CC BY-SA 4.0.
 */
import type { BroadcastMonthStatus, EpochMs, Id, IsoMonth } from '@outpost/shared/api';
import type { Db } from '../db/index.ts';
import { UPSTREAM, type Upstream } from '../http/upstream.ts';

/** The first broadcast month on database.lichess.org. */
export const FIRST_BROADCAST_MONTH: IsoMonth = '2020-01';

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** Download URL of one month. */
export const broadcastMonthUrl = (month: IsoMonth): string =>
  `${UPSTREAM.database}/broadcast/lichess_db_broadcast_${month}.pgn.zst`;

/** The UTC month of a time. */
export function monthOf(t: EpochMs): IsoMonth {
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** The month after (delta 1) or before (delta -1) `m`. */
export function addMonths(m: IsoMonth, delta: number): IsoMonth {
  const [y, mo] = m.split('-').map(Number) as [number, number];
  const idx = y * 12 + (mo - 1) + delta;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
}

/** Months from `from` to `to`, inclusive, ascending. */
export function monthRange(from: IsoMonth, to: IsoMonth): IsoMonth[] {
  const out: IsoMonth[] = [];
  for (let m = from; m <= to; m = addMonths(m, 1)) out.push(m);
  return out;
}

/**
 * Why a month cannot be imported, or null when it can: `YYYY-MM`, from 2020-01, and finished
 * (the current month and later months have no file yet).
 */
export function broadcastMonthProblem(month: string, now: EpochMs = Date.now()): string | null {
  if (!MONTH_RE.test(month)) return `${JSON.stringify(month)} is not a month (YYYY-MM)`;
  if (month < FIRST_BROADCAST_MONTH) return `${month} is before the first broadcast month (${FIRST_BROADCAST_MONTH})`;
  const current = monthOf(now);
  if (month > current) return `${month} is in the future`;
  if (month === current) return `${month} is not over yet (months are published about ten days after they end)`;
  return null;
}

/**
 * Months that are probably published, without asking upstream: up to last month once ten days of
 * this month have passed, else up to the month before.
 */
export function estimatedBroadcastMonths(now: EpochMs = Date.now()): IsoMonth[] {
  const day = new Date(now).getUTCDate();
  const last = addMonths(monthOf(now), day > 10 ? -1 : -2);
  return last < FIRST_BROADCAST_MONTH ? [] : monthRange(FIRST_BROADCAST_MONTH, last);
}

/** Months named in `list.txt` (one file URL per line). */
export function parseMonthList(text: string): IsoMonth[] {
  const months = new Set<IsoMonth>();
  for (const m of text.matchAll(/lichess_db_broadcast_(\d{4}-(?:0[1-9]|1[0-2]))\.pgn\.zst/g)) months.add(m[1]!);
  return [...months].sort();
}

/** How long the published list is trusted, and how long a failed fetch waits before retrying. */
const LIST_TTL_MS = 6 * 60 * 60 * 1000;
const LIST_RETRY_MS = 10 * 60 * 1000;
const LIST_TIMEOUT_MS = 5_000;

/** The published months (`list.txt`), cached per app; falls back to `estimatedBroadcastMonths`. */
export class BroadcastMonthCatalog {
  readonly #upstream: Upstream;
  readonly #now: () => number;
  #months: IsoMonth[] | null = null;
  #fetchedAt = 0;
  #failedAt = 0;
  #pending: Promise<void> | null = null;

  constructor(upstream: Upstream, now: () => number = Date.now) {
    this.#upstream = upstream;
    this.#now = now;
  }

  /**
   * Published months, ascending. With `refresh`, a stale list is fetched first (5 s timeout);
   * otherwise only what is cached (or the estimate) is returned and no request is made.
   */
  async months(opts: { refresh: boolean }): Promise<IsoMonth[]> {
    const now = this.#now();
    const stale = this.#months === null || now - this.#fetchedAt > LIST_TTL_MS;
    if (opts.refresh && stale && now - this.#failedAt > LIST_RETRY_MS) {
      this.#pending ??= this.#load().finally(() => {
        this.#pending = null;
      });
      await this.#pending;
    }
    return this.#months ?? estimatedBroadcastMonths(this.#now());
  }

  async #load(): Promise<void> {
    try {
      const res = await this.#upstream.fetch(`${UPSTREAM.database}/broadcast/list.txt`, { timeoutMs: LIST_TIMEOUT_MS });
      const months = parseMonthList(await res.text());
      if (months.length === 0) throw new Error('empty list');
      this.#months = months;
      this.#fetchedAt = this.#now();
    } catch {
      this.#failedAt = this.#now();
    }
  }
}

/** Records the outcome of a month import (see `reference_broadcast_months`). */
export function recordMonth(
  db: Db,
  databaseId: Id,
  month: IsoMonth,
  r: { ok: true; imported: number; duplicates: number; skipped: number; corrected?: number } | { ok: false; error: string },
): void {
  const now = Date.now();
  if (r.ok) {
    db.run(
      `INSERT INTO reference_broadcast_months (database_id, month, status, games, imported, duplicates, skipped, updated_at, imported_at, error)
       VALUES (?, ?, 'imported', ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT (database_id, month) DO UPDATE SET status = 'imported', games = excluded.games, imported = excluded.imported,
         duplicates = excluded.duplicates, skipped = excluded.skipped, updated_at = excluded.updated_at,
         imported_at = excluded.imported_at, error = NULL`,
      [databaseId, month, r.imported + r.duplicates + (r.corrected ?? 0), r.imported, r.duplicates, r.skipped, now, now],
    );
  } else {
    db.run(
      `INSERT INTO reference_broadcast_months (database_id, month, status, updated_at, error) VALUES (?, ?, 'error', ?, ?)
       ON CONFLICT (database_id, month) DO UPDATE SET status = 'error', updated_at = excluded.updated_at, error = excluded.error`,
      [databaseId, month, now, r.error.slice(0, 1000)],
    );
  }
}

/**
 * Import state of every month: published months, plus months with a record or an active job in
 * `databaseId` (null: nothing imported yet). Newest first.
 */
export function broadcastMonthStatuses(db: Db, databaseId: Id | null, published: readonly IsoMonth[]): BroadcastMonthStatus[] {
  const out = new Map<IsoMonth, BroadcastMonthStatus>();
  for (const m of published) out.set(m, { month: m, status: 'available', games: 0, importedAt: null, error: null });
  if (databaseId !== null) {
    for (const r of db.all<{ month: string; status: 'imported' | 'error'; games: number; imported_at: number | null; error: string | null }>(
      'SELECT month, status, games, imported_at, error FROM reference_broadcast_months WHERE database_id = ?',
      [databaseId],
    )) {
      out.set(r.month, { month: r.month, status: r.status, games: r.games, importedAt: r.imported_at, error: r.error });
    }
    for (const j of db.all<{ status: 'queued' | 'running'; month: string | null }>(
      `SELECT status, json_extract(payload_json, '$.month') AS month FROM jobs
        WHERE kind = 'broadcastMonth' AND status IN ('queued', 'running') AND json_extract(payload_json, '$.databaseId') = ?`,
      [databaseId],
    )) {
      if (!j.month || !MONTH_RE.test(j.month)) continue;
      const prev = out.get(j.month);
      out.set(j.month, {
        month: j.month,
        status: j.status === 'running' ? 'importing' : 'queued',
        games: prev?.games ?? 0,
        importedAt: prev?.importedAt ?? null,
        error: null,
      });
    }
  }
  return [...out.values()].sort((a, b) => (a.month < b.month ? 1 : a.month > b.month ? -1 : 0));
}
