/**
 * What the reference routes do (routes/reference.ts stays thin): `GET /api/reference`, queueing
 * broadcast months, and turning an import request (upload or URL) into a job.
 */
import type {
  BroadcastMonthsRequest,
  Id,
  ImportJobsResponse,
  ImportResponse,
  ReferenceImportRequest,
  ReferenceInfo,
} from '@outpost/shared/api';
import type { Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import { upstreamUnavailable, validationError } from '../http/errors.ts';
import { LICHESS_TOKEN_HOSTS } from '../http/upstream.ts';
import type { AuthUser } from '../http/types.ts';
import { enqueueJob, JOB_PRIORITY } from '../jobs/index.ts';
import { readSettings } from '../settings.ts';
import { broadcastRoundDedupeKey } from './autoImport.ts';
import {
  broadcastDatabaseId,
  ensureBroadcastDatabase,
  findOrCreateReferenceDatabase,
  listReferenceDatabases,
  markBroadcastData,
  referenceAttribution,
  requireReferenceDatabase,
  updateReferenceDatabaseLabels,
} from './databases.ts';
import { broadcastMonthProblem, broadcastMonthStatuses, type BroadcastMonthCatalog } from './months.ts';
import { importUrlProblem, lichessBroadcastUrl } from './urls.ts';

/** `GET /api/reference`. Admins refresh the published-month list (cached); others see the cache. */
export async function referenceInfo(db: Db, catalog: BroadcastMonthCatalog, viewer: AuthUser | null): Promise<ReferenceInfo> {
  const isAdmin = viewer?.role === 'admin';
  const databases = listReferenceDatabases(db, { isAdmin });
  const published = await catalog.months({ refresh: isAdmin });
  // Import state of the built-in database only when the viewer may see it.
  const builtin = broadcastDatabaseId(db);
  const visibleBuiltin = builtin !== null && databases.some(d => d.id === builtin) ? builtin : null;
  return {
    databases,
    totalGames: databases.reduce((n, d) => n + d.gameCount, 0),
    broadcastMonths: broadcastMonthStatuses(db, visibleBuiltin, published),
    attribution: referenceAttribution(db, { isAdmin }),
  };
}

/** Dedupe key of a month import job. */
export const broadcastMonthDedupeKey = (databaseId: Id, month: string): string => `broadcastMonth:${databaseId}:${month}`;

/**
 * `POST /api/admin/reference/broadcast-months`: one job per month (oldest first), into the built-in
 * database unless `databaseId` names another reference database. Re-queueing an imported month is
 * allowed (it only finds duplicates); a month already queued returns its job.
 */
export function enqueueBroadcastMonths(db: Db, req: BroadcastMonthsRequest, user: AuthUser, now = Date.now()): ImportJobsResponse {
  const months = [...new Set(req.months.map(m => m.trim()))].sort();
  const problems = months.map(m => broadcastMonthProblem(m, now)).filter((p): p is string => p !== null);
  if (problems.length) throw validationError(problems[0]!, { issues: problems.map(message => ({ path: 'months', message })) });
  return db.tx(() => {
    let databaseId: Id;
    if (req.databaseId !== undefined) {
      databaseId = requireReferenceDatabase(db, req.databaseId).id;
      markBroadcastData(db, databaseId);
    } else databaseId = ensureBroadcastDatabase(db);
    return {
      jobs: months.map(month =>
        enqueueJob(db, 'broadcastMonth', { databaseId, month }, {
          userId: user.id,
          priority: JOB_PRIORITY.manual,
          dedupeKey: broadcastMonthDedupeKey(databaseId, month),
        }),
      ),
    };
  });
}

/** Resolves (or creates) the target database of an import request. */
function targetDatabase(db: Db, req: ReferenceImportRequest, fallbackToBroadcast: boolean): Id {
  if (req.databaseId !== undefined) {
    const id = requireReferenceDatabase(db, req.databaseId).id;
    updateReferenceDatabaseLabels(db, id, req);
    return id;
  }
  if (req.databaseName) return findOrCreateReferenceDatabase(db, { name: req.databaseName, sourceLabel: req.sourceLabel ?? null, licence: req.licence ?? null });
  if (fallbackToBroadcast) return ensureBroadcastDatabase(db);
  throw validationError('databaseId or databaseName is required', {
    issues: [{ path: 'databaseName', message: 'Name the reference database to import into (or pass databaseId)' }],
  });
}

/**
 * `POST /api/admin/reference/import`: an uploaded file (already on disk, `file` = its name in the
 * uploads dir) or `req.url`. Lichess broadcast round pages become 'broadcastRound' jobs (token
 * required) and tour pages import the tour's PGN export; both default to the built-in database.
 */
export function enqueueReferenceImport(
  db: Db,
  config: Config,
  req: ReferenceImportRequest,
  upload: { file: string } | null,
  user: AuthUser,
): ImportResponse {
  const opts = { userId: user.id, priority: JOB_PRIORITY.manual };
  if (upload) {
    return db.tx(() => ({ job: enqueueJob(db, 'referenceImport', { databaseId: targetDatabase(db, req, false), file: upload.file }, opts) }));
  }
  const url = req.url?.trim();
  if (!url) throw validationError('Send a PGN file (multipart field "file") or a url');
  const problem = importUrlProblem(url);
  if (problem) throw validationError(problem, { issues: [{ path: 'url', message: problem }] });
  const lichess = lichessBroadcastUrl(url);
  if (lichess?.kind === 'round') {
    if (!readSettings(db, config).lichessToken) {
      throw upstreamUnavailable('Importing a Lichess broadcast round needs a Lichess API token: set LICHESS_TOKEN or add one in the admin settings', {
        reason: 'no_token',
      });
    }
    return db.tx(() => {
      const databaseId = targetDatabase(db, req, true);
      markBroadcastData(db, databaseId);
      return {
        job: enqueueJob(db, 'broadcastRound', { databaseId, roundId: lichess.roundId }, {
          ...opts,
          dedupeKey: broadcastRoundDedupeKey(databaseId, lichess.roundId),
        }),
      };
    });
  }
  const target = lichess?.pgnUrl ?? url;
  // Downloads from lichess.org itself share the lichess lane (one Lichess request at a time).
  const lane = LICHESS_TOKEN_HOSTS.has(new URL(target).hostname) ? ({ lane: 'lichess' } as const) : {};
  return db.tx(() => {
    const databaseId = targetDatabase(db, req, lichess !== null);
    if (lichess) markBroadcastData(db, databaseId);
    return { job: enqueueJob(db, 'referenceImport', { databaseId, url: target }, { ...opts, ...lane }) };
  });
}
