/**
 * The persistent job queue's write/read API (PLAN §7; table `jobs` in 001_init.sql).
 *
 * This is the cross-module surface of the jobs module: profiles enqueue syncs and show queue
 * positions, databases and reference enqueue imports, admin counts jobs. Other modules call these
 * functions and never write to `jobs` themselves. The workers, the scheduler, retry/backoff and
 * the admin endpoints are internal to the jobs module (owner: jobs), which may refine these
 * bodies but keeps the signatures.
 */
import {
  type EpochMs,
  type Id,
  type JobInfo,
  type JobKind,
  type JobLane,
  type JobPayloads,
  type JobProgress,
  type JobStatus,
  type SourceKind,
  type SourceSyncStatus,
} from '@outpost/shared/api';
import type { Db } from '../db/index.ts';

/** A `jobs` row. */
export interface JobRow {
  id: Id;
  kind: JobKind;
  lane: JobLane;
  payload_json: string;
  status: JobStatus;
  priority: number;
  user_id: Id | null;
  progress_json: string | null;
  error: string | null;
  attempts: number;
  run_after: EpochMs | null;
  created_at: EpochMs;
  started_at: EpochMs | null;
  finished_at: EpochMs | null;
  dedupe_key: string | null;
}

/** Column list for `SELECT ${JOB_COLUMNS} FROM jobs …` → `JobRow`. */
export const JOB_COLUMNS =
  'id, kind, lane, payload_json, status, priority, user_id, progress_json, error, attempts, run_after, created_at, started_at, finished_at, dedupe_key';

/** Priorities (higher runs first; ties run oldest first). */
export const JOB_PRIORITY = {
  /** Geo lookups and other housekeeping. */
  background: -10,
  /** The daily auto refresh and first imports started by the system. */
  scheduled: 0,
  /** A user pressed Update / uploaded a file. */
  manual: 10,
  /** Admin "high priority" updates. */
  high: 20,
} as const;

/** Options of `enqueueJob`. */
export interface EnqueueOptions {
  /** Default `JOB_PRIORITY.manual` when `userId` is set, else `JOB_PRIORITY.scheduled`. */
  priority?: number;
  /** The user the job is for (shown in /api/jobs/mine); null for system jobs. */
  userId?: Id | null;
  /**
   * At most one queued/running job per key: when one exists it is returned instead (its priority
   * is raised to `priority` if higher). Conventions: `sync:<sourceId>` (see `syncDedupeKey`),
   * `broadcastMonth:<dbId>:<YYYY-MM>`, `geo:<kind>`.
   */
  dedupeKey?: string | null;
  /** Don't start before this time (epoch ms). */
  runAfter?: EpochMs | null;
  /** Override the lane picked by `laneFor`. */
  lane?: JobLane;
}

/** Dedupe key of a source's sync job. Used by profile updates and the auto-refresh scheduler alike. */
export const syncDedupeKey = (sourceId: Id): string => `sync:${sourceId}`;

/**
 * Lane of a job: `sync` follows the source kind (lichess / chesscom; fide and pgn sources sync
 * locally), `geo` follows its payload, `broadcastRound` fetches from Lichess; imports and
 * rebuilds run on `local`.
 */
export function laneFor<K extends JobKind>(db: Db, kind: K, payload: JobPayloads[K]): JobLane {
  switch (kind) {
    case 'sync': {
      const { sourceId } = payload as JobPayloads['sync'];
      const sourceKind = db.value<SourceKind>('SELECT kind FROM sources WHERE id = ?', [sourceId]);
      return sourceKind === 'lichess' || sourceKind === 'chesscom' ? sourceKind : 'local';
    }
    case 'geo':
      return (payload as JobPayloads['geo']).kind;
    case 'broadcastRound':
      return 'lichess';
    default:
      return 'local';
  }
}

/** Human-readable label for the UI, e.g. "Sync lichess:DrNykterstein". */
export function jobLabel<K extends JobKind>(db: Db, kind: K, payload: JobPayloads[K]): string {
  const dbName = (id: Id | undefined): string =>
    (id !== undefined && db.value<string>('SELECT name FROM databases WHERE id = ?', [id])) || `database ${id ?? '?'}`;
  switch (kind) {
    case 'sync': {
      const p = payload as JobPayloads['sync'];
      const s = db.get<{ kind: string; display_name: string }>('SELECT kind, display_name FROM sources WHERE id = ?', [p.sourceId]);
      return s ? `Sync ${s.kind}:${s.display_name}` : `Sync source ${p.sourceId}`;
    }
    case 'geo': {
      const p = payload as JobPayloads['geo'];
      return `Look up ${p.keys.length} ${p.kind} player${p.keys.length === 1 ? '' : 's'}`;
    }
    case 'pgnImport': {
      const p = payload as JobPayloads['pgnImport'];
      return `Import ${p.originalName ?? 'PGN'} into ${dbName(p.databaseId)}`;
    }
    case 'referenceImport':
      return `Reference import into ${dbName((payload as JobPayloads['referenceImport']).databaseId)}`;
    case 'broadcastMonth':
      return `Lichess broadcasts ${(payload as JobPayloads['broadcastMonth']).month}`;
    case 'broadcastRound':
      return `Broadcast round ${(payload as JobPayloads['broadcastRound']).roundId}`;
    case 'rebuild': {
      const p = payload as JobPayloads['rebuild'];
      return p.sourceId !== undefined ? `Rebuild source ${p.sourceId}` : `Rebuild ${dbName(p.databaseId)}`;
    }
    default:
      return kind;
  }
}

/** 1-based position in the job's lane queue while queued, 0 while running, null otherwise. */
export function queuePosition(db: Db, jobId: Id): number | null {
  const row = db.get<Pick<JobRow, 'id' | 'lane' | 'status' | 'priority' | 'created_at'>>(
    'SELECT id, lane, status, priority, created_at FROM jobs WHERE id = ?',
    [jobId],
  );
  return row ? positionOf(db, row) : null;
}

function positionOf(db: Db, row: Pick<JobRow, 'id' | 'lane' | 'status' | 'priority' | 'created_at'>): number | null {
  if (row.status === 'running') return 0;
  if (row.status !== 'queued') return null;
  const ahead =
    db.value<number>(
      `SELECT COUNT(*) FROM jobs
        WHERE lane = :lane AND status = 'queued'
          AND (priority > :priority OR (priority = :priority AND (created_at < :created OR (created_at = :created AND id < :id))))`,
      { lane: row.lane, priority: row.priority, created: row.created_at, id: row.id },
    ) ?? 0;
  return ahead + 1;
}

const parseJson = <T>(json: string | null): T | null => {
  if (json === null) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
};

/** `jobs` row → `JobInfo` (label and queue position included). */
export function toJobInfo(db: Db, row: JobRow): JobInfo {
  const payload = parseJson<JobPayloads[JobKind]>(row.payload_json) ?? ({} as JobPayloads[JobKind]);
  return {
    id: row.id,
    kind: row.kind,
    lane: row.lane,
    status: row.status,
    priority: row.priority,
    label: jobLabel(db, row.kind, payload),
    userId: row.user_id,
    progress: parseJson<JobProgress>(row.progress_json),
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    queuePosition: positionOf(db, row),
  };
}

/** A job by id, or null. */
export function getJob(db: Db, id: Id): JobInfo | null {
  const row = db.get<JobRow>(`SELECT ${JOB_COLUMNS} FROM jobs WHERE id = ?`, [id]);
  return row ? toJobInfo(db, row) : null;
}

/**
 * Adds a job (or returns the active one with the same `dedupeKey`). Safe inside `db.tx()`.
 * Workers pick it up when `config.startWorkers` is on; in tests it just stays queued.
 */
export function enqueueJob<K extends JobKind>(
  db: Db,
  kind: K,
  payload: JobPayloads[K],
  opts: EnqueueOptions = {},
): JobInfo {
  const userId = opts.userId ?? null;
  const priority = opts.priority ?? (userId !== null ? JOB_PRIORITY.manual : JOB_PRIORITY.scheduled);
  const dedupeKey = opts.dedupeKey ?? null;
  return db.tx(() => {
    if (dedupeKey !== null) {
      const existing = db.get<JobRow>(
        `SELECT ${JOB_COLUMNS} FROM jobs WHERE dedupe_key = ? AND status IN ('queued', 'running')`,
        [dedupeKey],
      );
      if (existing) {
        if (existing.status === 'queued' && priority > existing.priority) {
          db.run('UPDATE jobs SET priority = ? WHERE id = ?', [priority, existing.id]);
          existing.priority = priority;
        }
        return toJobInfo(db, existing);
      }
    }
    const lane = opts.lane ?? laneFor(db, kind, payload);
    const { lastInsertRowid } = db.run(
      `INSERT INTO jobs (kind, lane, payload_json, status, priority, user_id, run_after, created_at, dedupe_key)
       VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
      [kind, lane, JSON.stringify(payload), priority, userId, opts.runAfter ?? null, Date.now(), dedupeKey],
    );
    return getJob(db, lastInsertRowid)!;
  });
}

/** Enqueues a sync of one source (deduplicated with `syncDedupeKey`). */
export function enqueueSync(db: Db, sourceId: Id, opts: Omit<EnqueueOptions, 'dedupeKey'> & { full?: boolean } = {}): JobInfo {
  const { full, ...rest } = opts;
  return enqueueJob(db, 'sync', full ? { sourceId, full: true } : { sourceId }, { ...rest, dedupeKey: syncDedupeKey(sourceId) });
}

/**
 * Sync status of sources (for ProfileHeader / ProfileStatus): the active sync job if any, else
 * `sources.last_synced_at` / `last_sync_error`. Unknown ids are left out of the map.
 */
export function sourceSyncStatus(db: Db, sourceIds: readonly Id[]): Map<Id, SourceSyncStatus> {
  const out = new Map<Id, SourceSyncStatus>();
  for (const id of sourceIds) {
    const src = db.get<{ last_synced_at: EpochMs | null; last_sync_error: string | null }>(
      'SELECT last_synced_at, last_sync_error FROM sources WHERE id = ?',
      [id],
    );
    if (!src) continue;
    const job = db.get<JobRow>(
      `SELECT ${JOB_COLUMNS} FROM jobs WHERE dedupe_key = ? AND status IN ('queued', 'running')`,
      [syncDedupeKey(id)],
    );
    out.set(id, {
      state: job ? (job.status as 'queued' | 'running') : src.last_sync_error ? 'error' : src.last_synced_at ? 'idle' : 'never',
      lastSyncedAt: src.last_synced_at,
      lastError: src.last_sync_error,
      progress: job ? parseJson<JobProgress>(job.progress_json) : null,
      queuePosition: job ? positionOf(db, job) : null,
      jobId: job?.id ?? null,
    });
  }
  return out;
}
