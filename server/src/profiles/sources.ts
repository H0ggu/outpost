/**
 * Sources: the sync identities behind profiles (PLAN §4 `sources`, §5 "Link accounts").
 *
 * - `resolveSource` turns a user's `NewSourceInput` into a row to reuse or create. Existing rows
 *   are reused through UNIQUE(kind, key) without any upstream call; new Lichess / Chess.com
 *   accounts are checked upstream (through `app.upstream`), FIDE ids against the local games and
 *   Lichess's FIDE directory, and PGN players against their (visible) database.
 * - `insertSource` writes a resolved row (race-safe with ON CONFLICT).
 * - `sourceSummaries` builds `SourceSummary` rows (sync status, game counts, current ratings).
 *
 * `profile_json` holds the latest upstream snapshot. This module writes it when a source is
 * created; the sync engine (jobs module) refreshes it. The readers here accept these shapes:
 * - lichess: the `GET /api/user/{u}` object (`perfs`, `profile.flag`, `profile.fideRating`),
 *   optionally wrapped as `{user: …}`;
 * - chesscom: `{player, stats}` (the `/pub/player/{u}` and `/stats` objects), or the stats object itself;
 * - fide: Lichess's `GET /api/fide/player/{id}` object (`standard`, `rapid`, `blitz`, `federation`).
 */
import type {
  CurrentRating,
  EpochMs,
  Id,
  NewSourceInput,
  SourceKind,
  SourceSummary,
  SourceSyncStatus,
  TimeClass,
  Title,
} from '@outpost/shared/api';
import { isTitle, playerKey, TIME_CLASSES } from '@outpost/shared/chess';
import { pgnSourceKey } from '../chess/store.ts';
import type { Db } from '../db/index.ts';
import { HttpError, validationError } from '../http/errors.ts';
import type { AuthUser } from '../http/types.ts';
import { UPSTREAM, upstreamHttpError, UpstreamError, type Upstream } from '../http/upstream.ts';
import { sourceSyncStatus } from '../jobs/index.ts';
import { loadDatabaseForViewer } from './access.ts';

/** Lichess usernames: 2–30 letters, digits, `_` or `-`. */
export const LICHESS_USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,29}$/;
/** Chess.com usernames (lenient: old accounts break today's 3–25 rule). */
export const CHESSCOM_USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,49}$/;
/** FIDE ids are positive integers. */
export const FIDE_ID_RE = /^[1-9]\d{0,11}$/;
/** Longest PGN player name accepted as a `pgn` source. */
export const MAX_PGN_NAME_LENGTH = 200;

/** Timeout of the account checks made while creating a profile. */
const CHECK_TIMEOUT_MS = 8000;

/** A `sources` row as this module reads it. */
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
  last_synced_at: EpochMs | null;
  last_sync_error: string | null;
}

/** Columns for `SourceRow` (table alias `s`). */
export const SOURCE_COLUMNS =
  's.id, s.kind, s.key, s.display_name, s.site_user_id, s.title, s.country, s.database_id, s.profile_json, s.last_synced_at, s.last_sync_error';

/** A source ready to attach: an existing row, or the values of a new one. */
export interface ResolvedSource {
  kind: SourceKind;
  key: string;
  displayName: string;
  siteUserId: string | null;
  title: Title | null;
  country: string | null;
  databaseId: Id | null;
  profileJson: string | null;
  /** Set when the row already exists (nothing to insert). */
  existingId: Id | null;
}

const isoCountry = (v: unknown): string | null => (typeof v === 'string' && /^[A-Z]{2}$/.test(v) ? v : null);
const titleOf = (v: unknown): Title | null => (isTitle(v) ? v : null);
const obj = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const existingSource = (db: Db, kind: SourceKind, key: string): SourceRow | undefined =>
  db.get<SourceRow>(`SELECT ${SOURCE_COLUMNS} FROM sources s WHERE s.kind = ? AND s.key = ?`, [kind, key]);

const reuse = (row: SourceRow): ResolvedSource => ({
  kind: row.kind,
  key: row.key,
  displayName: row.display_name,
  siteUserId: row.site_user_id,
  title: titleOf(row.title),
  country: row.country,
  databaseId: row.database_id,
  profileJson: row.profile_json,
  existingId: row.id,
});

/** Rethrows upstream failures as the API error a route answers with (503 / 502). */
function rethrowUpstream(e: unknown): never {
  throw upstreamHttpError(e);
}

/**
 * Resolves one requested source. Throws 400 `validation` for malformed or unknown accounts,
 * 503/502 when the upstream check itself fails. `index` names the source in error details.
 */
export async function resolveSource(
  ctx: { db: Db; upstream: Upstream; viewer: AuthUser },
  input: NewSourceInput,
  index = 0,
): Promise<ResolvedSource> {
  const fail = (message: string): never => {
    throw validationError(message, { issues: [{ path: `sources.${index}.key`, message }] });
  };
  const raw = input.key.trim();
  switch (input.kind) {
    case 'lichess': {
      if (!LICHESS_USERNAME_RE.test(raw)) fail(`"${raw}" is not a valid Lichess username`);
      const key = playerKey(raw);
      const row = existingSource(ctx.db, 'lichess', key);
      if (row) return reuse(row);
      return checkLichessUser(ctx.upstream, key, fail);
    }
    case 'chesscom': {
      if (!CHESSCOM_USERNAME_RE.test(raw)) fail(`"${raw}" is not a valid Chess.com username`);
      const key = playerKey(raw);
      const row = existingSource(ctx.db, 'chesscom', key);
      if (row) return reuse(row);
      return checkChesscomUser(ctx.upstream, key, fail);
    }
    case 'fide': {
      if (!FIDE_ID_RE.test(raw)) fail(`"${raw}" is not a FIDE id`);
      const row = existingSource(ctx.db, 'fide', raw);
      if (row) return reuse(row);
      return checkFideId(ctx.db, ctx.upstream, raw, fail);
    }
    case 'pgn': {
      if (input.databaseId === undefined) {
        throw validationError('A pgn source needs a databaseId', {
          issues: [{ path: `sources.${index}.databaseId`, message: 'required for pgn sources' }],
        });
      }
      if (raw.length === 0 || raw.length > MAX_PGN_NAME_LENGTH) fail('Enter the player name as written in the PGN');
      let database;
      try {
        database = loadDatabaseForViewer(ctx.db, input.databaseId, ctx.viewer);
      } catch (e) {
        if (e instanceof HttpError && e.statusCode === 404) {
          throw validationError(`Database ${input.databaseId} not found`, {
            issues: [{ path: `sources.${index}.databaseId`, message: 'not found' }],
          });
        }
        throw e;
      }
      const key = pgnSourceKey(database.id, raw);
      const row = existingSource(ctx.db, 'pgn', key);
      if (row) return reuse(row);
      const name = playerKey(raw);
      const played = ctx.db.value<number>(
        'SELECT 1 FROM games WHERE database_id = ? AND (white_key = ? OR black_key = ?) LIMIT 1',
        [database.id, name, name],
      );
      if (played === undefined && !hasPendingImport(ctx.db, database.id)) {
        fail(`No games of "${raw}" in database "${database.name}"`);
      }
      return {
        kind: 'pgn',
        key,
        displayName: raw,
        siteUserId: null,
        title: null,
        country: null,
        databaseId: database.id,
        profileJson: null,
        existingId: null,
      };
    }
  }
}

/** True while a PGN import into the database is queued or running. */
function hasPendingImport(db: Db, databaseId: Id): boolean {
  return (
    db.value<number>(
      `SELECT 1 FROM database_imports di JOIN jobs j ON j.id = di.job_id
        WHERE di.database_id = ? AND j.status IN ('queued', 'running') LIMIT 1`,
      [databaseId],
    ) !== undefined
  );
}

async function checkLichessUser(upstream: Upstream, key: string, fail: (m: string) => never): Promise<ResolvedSource> {
  let user: Record<string, unknown> | null;
  try {
    const res = await upstream.fetch(`${UPSTREAM.lichess}/api/user/${encodeURIComponent(key)}`, {
      auth: 'optional',
      allowStatuses: [404],
      timeoutMs: CHECK_TIMEOUT_MS,
      headers: { accept: 'application/json' },
    });
    if (res.status === 404) {
      void res.body?.cancel().catch(() => {});
      return fail(`No Lichess account "${key}"`);
    }
    user = obj(await res.json());
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if (e instanceof SyntaxError) rethrowUpstream(new UpstreamError('status', 'lichess.org', 'Invalid JSON from lichess.org'));
    rethrowUpstream(e);
  }
  if (!user || typeof user.id !== 'string') return fail(`No Lichess account "${key}"`);
  if (user.disabled === true) fail(`The Lichess account "${key}" is closed`);
  const profile = obj(user.profile);
  return {
    kind: 'lichess',
    key: playerKey(user.id),
    displayName: typeof user.username === 'string' ? user.username : key,
    siteUserId: user.id,
    title: titleOf(user.title),
    country: isoCountry(profile?.flag),
    databaseId: null,
    profileJson: JSON.stringify(user),
    existingId: null,
  };
}

async function checkChesscomUser(upstream: Upstream, key: string, fail: (m: string) => never): Promise<ResolvedSource> {
  const base = `${UPSTREAM.chesscom}/pub/player/${encodeURIComponent(key)}`;
  let player: Record<string, unknown> | null;
  try {
    const res = await upstream.fetch(base, {
      allowStatuses: [404, 410],
      timeoutMs: CHECK_TIMEOUT_MS,
      headers: { accept: 'application/json' },
    });
    if (res.status === 404 || res.status === 410) {
      void res.body?.cancel().catch(() => {});
      return fail(`No Chess.com account "${key}"`);
    }
    player = obj(await res.json());
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if (e instanceof SyntaxError) rethrowUpstream(new UpstreamError('status', 'api.chess.com', 'Invalid JSON from api.chess.com'));
    rethrowUpstream(e);
  }
  if (!player || typeof player.username !== 'string') return fail(`No Chess.com account "${key}"`);
  // Ratings are a bonus for the header before the first sync: a failure here is not fatal.
  let stats: Record<string, unknown> | null = null;
  try {
    stats = obj(await upstream.json<unknown>(`${base}/stats`, { timeoutMs: CHECK_TIMEOUT_MS }));
  } catch {
    stats = null;
  }
  // `url` keeps the display case (https://www.chess.com/member/Hikaru); `username` is lowercase.
  const fromUrl = typeof player.url === 'string' ? /\/member\/([^/?#]+)$/.exec(player.url)?.[1] : undefined;
  const display = fromUrl && playerKey(decodeURIComponent(fromUrl)) === key ? decodeURIComponent(fromUrl) : player.username;
  const countryCode = typeof player.country === 'string' ? player.country.slice(player.country.lastIndexOf('/') + 1) : null;
  return {
    kind: 'chesscom',
    key,
    displayName: display,
    siteUserId: typeof player.player_id === 'number' ? String(player.player_id) : null,
    title: titleOf(player.title),
    country: isoCountry(countryCode),
    databaseId: null,
    profileJson: JSON.stringify({ player, stats }),
    existingId: null,
  };
}

async function checkFideId(db: Db, upstream: Upstream, fideId: string, fail: (m: string) => never): Promise<ResolvedSource> {
  // The newest stored game with this FIDE id gives the name as the reference DB writes it.
  const local = db.get<{ name: string; title: string | null }>(
    `SELECT CASE WHEN white_fide_id = ?1 THEN white ELSE black END AS name,
            CASE WHEN white_fide_id = ?1 THEN white_title ELSE black_title END AS title
       FROM games WHERE white_fide_id = ?1 OR black_fide_id = ?1
      ORDER BY ended_at DESC LIMIT 1`,
    [fideId],
  );
  // Lichess's copy of the FIDE rating list adds the official name, title, federation and ratings.
  let fide: Record<string, unknown> | null = null;
  try {
    const res = await upstream.fetch(`${UPSTREAM.lichess}/api/fide/player/${fideId}`, {
      allowStatuses: [404],
      timeoutMs: CHECK_TIMEOUT_MS,
      headers: { accept: 'application/json' },
    });
    if (res.status === 404) void res.body?.cancel().catch(() => {});
    else fide = obj(await res.json());
  } catch (e) {
    // Without local games the id can't be checked at all; with them the lookup is optional.
    if (!local) rethrowUpstream(e instanceof SyntaxError ? new UpstreamError('status', 'lichess.org', 'Invalid JSON from lichess.org') : e);
  }
  const fideName = typeof fide?.name === 'string' && fide.name.trim() ? fide.name.trim() : null;
  if (!local && !fideName) return fail(`Unknown FIDE id ${fideId}`);
  return {
    kind: 'fide',
    key: fideId,
    displayName: fideName ?? local!.name,
    siteUserId: fideId,
    title: titleOf(fide?.title) ?? titleOf(local?.title),
    country: null,
    databaseId: null,
    profileJson: fide ? JSON.stringify(fide) : null,
    existingId: null,
  };
}

/** Inserts a resolved source (or finds the row another request created meanwhile). */
export function insertSource(db: Db, r: ResolvedSource): { id: Id; created: boolean } {
  if (r.existingId !== null) return { id: r.existingId, created: false };
  const res = db.run(
    `INSERT INTO sources (kind, key, display_name, site_user_id, title, country, database_id, profile_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (kind, key) DO NOTHING`,
    [r.kind, r.key, r.displayName, r.siteUserId, r.title, r.country, r.databaseId, r.profileJson, Date.now()],
  );
  if (res.changes > 0) return { id: res.lastInsertRowid, created: true };
  return { id: db.value<Id>('SELECT id FROM sources WHERE kind = ? AND key = ?', [r.kind, r.key])!, created: false };
}

/** Link to the account on its site (null for PGN players). */
export function sourceUrl(kind: SourceKind, key: string, displayName: string): string | null {
  switch (kind) {
    case 'lichess':
      return `https://lichess.org/@/${encodeURIComponent(displayName || key)}`;
    case 'chesscom':
      return `https://www.chess.com/member/${encodeURIComponent(displayName || key)}`;
    case 'fide':
      return `https://ratings.fide.com/profile/${encodeURIComponent(key)}`;
    case 'pgn':
      return null;
  }
}

/** Rating snapshot of one time class from `profile_json`. */
interface SnapshotRating {
  rating: number;
  rd: number | null;
  provisional: boolean;
}

const parseJson = (s: string | null): Record<string, unknown> | null => {
  if (!s) return null;
  try {
    return obj(JSON.parse(s));
  } catch {
    return null;
  }
};

const LICHESS_PERFS: ReadonlyArray<[string, TimeClass]> = [
  ['bullet', 'bullet'],
  ['blitz', 'blitz'],
  ['rapid', 'rapid'],
  ['classical', 'classical'],
  ['correspondence', 'correspondence'],
];
const CHESSCOM_STATS: ReadonlyArray<[string, TimeClass]> = [
  ['chess_bullet', 'bullet'],
  ['chess_blitz', 'blitz'],
  ['chess_rapid', 'rapid'],
  ['chess_daily', 'correspondence'],
];

const chesscomStatsOf = (snap: Record<string, unknown>): Record<string, unknown> | null =>
  obj(snap.stats) ?? (CHESSCOM_STATS.some(([k]) => k in snap) || 'fide' in snap ? snap : null);

/** Current site ratings per time class from a source's snapshot (lichess and chesscom only). */
export function snapshotRatings(kind: SourceKind, profileJson: string | null): Map<TimeClass, SnapshotRating> {
  const out = new Map<TimeClass, SnapshotRating>();
  const snap = parseJson(profileJson);
  if (!snap) return out;
  if (kind === 'lichess') {
    const perfs = obj(snap.perfs) ?? obj(obj(snap.user)?.perfs);
    for (const [perf, tc] of LICHESS_PERFS) {
      const p = obj(perfs?.[perf]);
      const rating = num(p?.rating);
      if (!p || rating === null || (num(p.games) ?? 0) <= 0) continue;
      out.set(tc, { rating: Math.round(rating), rd: num(p.rd), provisional: p.prov === true });
    }
  } else if (kind === 'chesscom') {
    const stats = chesscomStatsOf(snap);
    for (const [key, tc] of CHESSCOM_STATS) {
      const last = obj(obj(stats?.[key])?.last);
      const rating = num(last?.rating);
      if (rating === null) continue;
      out.set(tc, { rating: Math.round(rating), rd: num(last?.rd), provisional: false });
    }
  }
  return out;
}

/** FIDE ratings known for a source (FIDE directory, Lichess profile field, Chess.com stats). */
export function fideRatings(kind: SourceKind, profileJson: string | null): SourceSummary['fide'] {
  const snap = parseJson(profileJson);
  if (!snap) return null;
  const positive = (v: unknown): number | null => {
    const n = num(v);
    return n !== null && n > 0 ? Math.round(n) : null;
  };
  let fide: SourceSummary['fide'] = null;
  if (kind === 'fide') fide = { standard: positive(snap.standard), rapid: positive(snap.rapid), blitz: positive(snap.blitz) };
  else if (kind === 'lichess') {
    const profile = obj(snap.profile) ?? obj(obj(snap.user)?.profile);
    fide = { standard: positive(profile?.fideRating), rapid: null, blitz: null };
  } else if (kind === 'chesscom') fide = { standard: positive(chesscomStatsOf(snap)?.fide), rapid: null, blitz: null };
  return fide && (fide.standard !== null || fide.rapid !== null || fide.blitz !== null) ? fide : null;
}

/**
 * Current rating per time class: the site's snapshot when the sync stored one, otherwise the
 * rating after the latest game in that time class (rated games first). `games` always counts
 * Outpost's stored games.
 */
export function currentRatings(db: Db, source: Pick<SourceRow, 'id' | 'kind' | 'profile_json'>): CurrentRating[] {
  const rows = db.all<{ time_class: TimeClass; games: number; rating: number | null }>(
    `SELECT pg.time_class, COUNT(*) AS games,
            COALESCE(
              (SELECT COALESCE(r.rating_after, r.rating) FROM player_games r
                WHERE r.source_id = ?1 AND r.time_class = pg.time_class AND r.rated = 1
                  AND COALESCE(r.rating_after, r.rating) IS NOT NULL
                ORDER BY r.ended_at DESC LIMIT 1),
              (SELECT COALESCE(r.rating_after, r.rating) FROM player_games r
                WHERE r.source_id = ?1 AND r.time_class = pg.time_class
                  AND COALESCE(r.rating_after, r.rating) IS NOT NULL
                ORDER BY r.ended_at DESC LIMIT 1)
            ) AS rating
       FROM player_games pg WHERE pg.source_id = ?1 GROUP BY pg.time_class`,
    [source.id],
  );
  const games = new Map(rows.map(r => [r.time_class, r]));
  const snapshot = snapshotRatings(source.kind, source.profile_json);
  const out: CurrentRating[] = [];
  for (const tc of TIME_CLASSES) {
    const snap = snapshot.get(tc);
    const row = games.get(tc);
    if (snap) out.push({ timeClass: tc, rating: snap.rating, games: row?.games ?? 0, rd: snap.rd, provisional: snap.provisional });
    else if (row && row.rating !== null) out.push({ timeClass: tc, rating: row.rating, games: row.games, rd: null, provisional: false });
  }
  return out;
}

/** Stored games per source. */
export function gameCounts(db: Db, sourceIds: readonly Id[]): Map<Id, number> {
  const out = new Map<Id, number>();
  if (sourceIds.length === 0) return out;
  const rows = db.all<{ source_id: Id; n: number }>(
    `SELECT source_id, COUNT(*) AS n FROM player_games WHERE source_id IN (${sourceIds.map(() => '?').join(', ')}) GROUP BY source_id`,
    sourceIds,
  );
  for (const r of rows) out.set(r.source_id, r.n);
  return out;
}

const NEVER_SYNCED: SourceSyncStatus = {
  state: 'never',
  lastSyncedAt: null,
  lastError: null,
  progress: null,
  queuePosition: null,
  jobId: null,
};

/** `SourceSummary` rows for sources (in the given order). */
export function sourceSummaries(db: Db, rows: ReadonlyArray<SourceRow & { hidden: number }>): SourceSummary[] {
  const ids = rows.map(r => r.id);
  const syncs = sourceSyncStatus(db, ids);
  const counts = gameCounts(db, ids);
  return rows.map(r => ({
    id: r.id,
    kind: r.kind,
    key: r.key,
    displayName: r.display_name,
    url: sourceUrl(r.kind, r.key, r.display_name),
    title: titleOf(r.title),
    country: r.country,
    hidden: r.hidden === 1,
    databaseId: r.kind === 'pgn' ? r.database_id : null,
    gameCount: counts.get(r.id) ?? 0,
    ratings: currentRatings(db, r),
    fide: fideRatings(r.kind, r.profile_json),
    sync: syncs.get(r.id) ?? NEVER_SYNCED,
  }));
}
