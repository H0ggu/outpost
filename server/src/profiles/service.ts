/**
 * Profiles: create, list, header, edit, delete, sources, manual updates, status, bookmarks and
 * views (PLAN §4 profiles/profile_sources/bookmarks/profile_views, §5, §6 "Search and profiles", §7).
 *
 * Access: every function takes a `ViewableProfile` from `loadProfileForViewer` (404 for private
 * profiles of others); mutations additionally need `canEdit` (owner or admin, `requireEditor`).
 *
 * Orphan policy: a source stays as long as any profile uses it. When the last profile lets go of
 * a source (profile delete, account removal), the source row is deleted with its `player_games`
 * rows and its queued sync job is cancelled; for Lichess / Chess.com sources the games nobody else
 * references (no `player_games` row left, not in a database) are deleted too, positions included.
 * PGN and reference games always stay in their database. Small clean-ups run inside the request;
 * large ones continue in the background in short batches (`collectOrphanGames`), so the API stays
 * responsive. Source ids are never reused (AUTOINCREMENT, migration 501), so a sync that was
 * already running when its source went away writes nothing to another account; the games it still
 * stores reference nothing and are collected by `sweepOrphans`.
 *
 * Profiles also disappear without passing through here: deleting a user deletes their profiles
 * (`profiles.owner_user_id ON DELETE CASCADE`). `sweepOrphans` applies the same policy to every
 * source no profile uses and to games nothing references; routes/profiles.ts runs it at startup
 * and every few hours while the workers run, and the auth module may call it after deleting a user.
 */
import type {
  BookmarkResponse,
  CreateProfileRequest,
  EpochMs,
  Id,
  JobInfo,
  NewSourceInput,
  ProfileHeader,
  ProfileListQuery,
  ProfileQueueInfo,
  ProfileStatus,
  ProfileSummary,
  ProfileUpdateResponse,
  SourceKind,
  SourceSummary,
  SourceSyncStatus,
  Title,
  UpdateProfileRequest,
  Visibility,
} from '@outpost/shared/api';
import { SLUG_RE, slugify } from '@outpost/shared/api';
import { isTitle, playerKey } from '@outpost/shared/chess';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import { z } from 'zod';
import { rebuildPlayerGames } from '../chess/store.ts';
import type { Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import { conflict, forbidden, HttpError, validationError } from '../http/errors.ts';
import type { AuthUser } from '../http/types.ts';
import type { Upstream } from '../http/upstream.ts';
import { cancelQueuedJobs, enqueueSync, JOB_PRIORITY, sourceSyncStatus, syncDedupeKey } from '../jobs/index.ts';
import { readSettings, type InstanceSettings } from '../settings.ts';
import { loadProfileByIdForViewer, type ViewableProfile } from './access.ts';
import { insertSource, resolveSource, SOURCE_COLUMNS, sourceSummaries, type ResolvedSource, type SourceRow } from './sources.ts';

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

/** Most sources one profile may combine. */
export const MAX_PROFILE_SOURCES = 30;

const noControlChars = (s: string): boolean => !/[\u0000-\u001f\u007f]/.test(s);

const displayNameSchema = z
  .string()
  .trim()
  .min(1, 'enter a name')
  .max(100)
  .refine(noControlChars, 'control characters are not allowed');

/** `NewSourceInput`. */
export const newSourceSchema = z.object({
  kind: z.enum(['lichess', 'chesscom', 'fide', 'pgn']),
  key: z.string().trim().min(1).max(200),
  databaseId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
});

/** `CreateProfileRequest`. */
export const createProfileSchema = z.object({
  displayName: displayNameSchema,
  slug: z.string().regex(SLUG_RE, 'use 2–64 lowercase letters, digits and dashes').optional(),
  visibility: z.enum(['private', 'public']).optional(),
  autoRefresh: z.boolean().optional(),
  sources: z.array(newSourceSchema).min(1, 'add at least one account').max(MAX_PROFILE_SOURCES),
});

/** `UpdateProfileRequest`. */
export const updateProfileSchema = z.object({
  displayName: displayNameSchema.optional(),
  slug: z.string().regex(SLUG_RE, 'use 2–64 lowercase letters, digits and dashes').optional(),
  visibility: z.enum(['private', 'public']).optional(),
  autoRefresh: z.boolean().optional(),
  hiddenSourceIds: z.array(z.number().int().positive()).max(MAX_PROFILE_SOURCES * 4).optional(),
});

/** `ProfileListQuery` (scope defaults to `mine` when signed in, `public` otherwise). */
export const profileListQuerySchema = z.object({ scope: z.enum(['mine', 'public', 'recent']).optional() });

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** What the profile functions need from the app. */
export interface ProfilesCtx {
  db: Db;
  config: Config;
  upstream: Upstream;
}

/** 403 unless the viewer may edit the profile (owner or admin). */
export function requireEditor(profile: ViewableProfile): void {
  if (!profile.canEdit) throw forbidden('Only the owner or an admin can change this profile');
}

interface ProfileRow {
  id: Id;
  slug: string;
  display_name: string;
  owner_user_id: Id | null;
  owner_username: string | null;
  visibility: Visibility;
  auto_refresh: number;
  created_at: EpochMs;
  updated_at: EpochMs;
  views: number;
  update_requested_at: EpochMs | null;
}

const PROFILE_COLUMNS = `p.id, p.slug, p.display_name, p.owner_user_id, u.username AS owner_username, p.visibility,
  p.auto_refresh, p.created_at, p.updated_at, p.views, p.update_requested_at`;

const profileRow = (db: Db, id: Id): ProfileRow =>
  db.get<ProfileRow>(`SELECT ${PROFILE_COLUMNS} FROM profiles p LEFT JOIN users u ON u.id = p.owner_user_id WHERE p.id = ?`, [id])!;

const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

/** The sources of a profile the viewer may see, in the order they were attached. */
function visibleSourceRows(db: Db, profile: ViewableProfile): Array<SourceRow & { hidden: number }> {
  if (profile.sourceIds.length === 0) return [];
  return db.all<SourceRow & { hidden: number }>(
    `SELECT ${SOURCE_COLUMNS}, ps.hidden FROM profile_sources ps JOIN sources s ON s.id = ps.source_id
      WHERE ps.profile_id = ? AND s.id IN (${placeholders(profile.sourceIds.length)}) ORDER BY ps.position, s.id`,
    [profile.id, ...profile.sourceIds],
  );
}

/** Earliest next manual update for the viewer, or null when allowed now (admins: always now). */
function cooldownUntil(row: Pick<ProfileRow, 'update_requested_at'>, settings: InstanceSettings, viewer: AuthUser | null, now: number): EpochMs | null {
  if (viewer?.role === 'admin' || row.update_requested_at === null) return null;
  const until = row.update_requested_at + settings.updateCooldownMinutes * 60_000;
  return until > now ? until : null;
}

function queueInfo(syncs: readonly SourceSyncStatus[], cooldown: EpochMs | null): ProfileQueueInfo {
  // Best position among the queued jobs (a running one is 0, which says nothing about the queue).
  const positions = syncs.filter(s => s.state === 'queued').map(s => s.queuePosition).filter((p): p is number => p !== null);
  return {
    busy: syncs.some(s => s.state === 'queued' || s.state === 'running'),
    cooldownUntil: cooldown,
    queuePosition: positions.length ? Math.min(...positions) : null,
  };
}

const maxOrNull = (values: ReadonlyArray<number | null>): number | null => {
  const v = values.filter((x): x is number => x !== null);
  return v.length ? Math.max(...v) : null;
};

const isBookmarked = (db: Db, viewer: AuthUser | null, profileId: Id): boolean =>
  viewer !== null && db.value('SELECT 1 FROM bookmarks WHERE user_id = ? AND profile_id = ?', [viewer.id, profileId]) !== undefined;

// ---------------------------------------------------------------------------
// Header, status, summaries
// ---------------------------------------------------------------------------

/** `GET /api/profiles/:slug` body. */
export function profileHeader(db: Db, config: Config, profile: ViewableProfile, viewer: AuthUser | null): ProfileHeader {
  const row = profileRow(db, profile.id);
  const sources: SourceSummary[] = sourceSummaries(db, visibleSourceRows(db, profile));
  const totals = { w: 0, d: 0, l: 0, games: 0 };
  if (profile.sourceIds.length) {
    for (const r of db.all<{ outcome: 'w' | 'd' | 'l'; n: number }>(
      `SELECT outcome, COUNT(*) AS n FROM player_games WHERE source_id IN (${placeholders(profile.sourceIds.length)}) GROUP BY outcome`,
      profile.sourceIds,
    )) {
      totals[r.outcome] = r.n;
      totals.games += r.n;
    }
  }
  const settings = readSettings(db, config);
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.display_name,
    visibility: row.visibility,
    autoRefresh: row.auto_refresh === 1,
    owner: row.owner_user_id !== null && row.owner_username !== null ? { id: row.owner_user_id, username: row.owner_username } : null,
    canEdit: profile.canEdit,
    bookmarked: isBookmarked(db, viewer, row.id),
    sources,
    totals,
    lastUpdated: maxOrNull(sources.map(s => s.sync.lastSyncedAt)),
    queue: queueInfo(
      sources.map(s => s.sync),
      cooldownUntil(row, settings, viewer, Date.now()),
    ),
    views: row.views,
    createdAt: row.created_at,
  };
}

/** `GET /api/profiles/:slug/status` body: cheap enough to poll every few seconds. */
export function profileStatus(db: Db, config: Config, profile: ViewableProfile, viewer: AuthUser | null): ProfileStatus {
  const row = profileRow(db, profile.id);
  const syncs = sourceSyncStatus(db, profile.sourceIds);
  const counts = new Map(
    profile.sourceIds.length
      ? db
          .all<{ source_id: Id; n: number }>(
            `SELECT source_id, COUNT(*) AS n FROM player_games WHERE source_id IN (${placeholders(profile.sourceIds.length)}) GROUP BY source_id`,
            profile.sourceIds,
          )
          .map(r => [r.source_id, r.n] as const)
      : [],
  );
  const sources = profile.sourceIds
    .filter(id => syncs.has(id))
    .map(id => ({ sourceId: id, sync: syncs.get(id)!, gameCount: counts.get(id) ?? 0 }));
  return {
    sources,
    queue: queueInfo(
      sources.map(s => s.sync),
      cooldownUntil(row, readSettings(db, config), viewer, Date.now()),
    ),
    lastUpdated: maxOrNull(sources.map(s => s.sync.lastSyncedAt)),
  };
}

/**
 * `ProfileSummary` rows for profiles the viewer may see, in the order of `ids`. Ids that are
 * missing or not visible are skipped (callers pre-filter, this is the last line of defence).
 */
export function profileSummaries(db: Db, ids: readonly Id[], viewer: AuthUser | null): ProfileSummary[] {
  const out: ProfileSummary[] = [];
  for (const id of ids) {
    let profile: ViewableProfile;
    try {
      profile = loadProfileByIdForViewer(db, id, viewer);
    } catch (e) {
      if (e instanceof HttpError && e.statusCode === 404) continue;
      throw e;
    }
    const row = profileRow(db, id);
    const sources = profile.sourceIds.length
      ? db.all<{ kind: SourceKind; key: string; display_name: string; title: string | null; country: string | null; last_synced_at: EpochMs | null }>(
          `SELECT s.kind, s.key, s.display_name, s.title, s.country, s.last_synced_at
             FROM profile_sources ps JOIN sources s ON s.id = ps.source_id
            WHERE ps.profile_id = ? AND s.id IN (${placeholders(profile.sourceIds.length)}) ORDER BY ps.position, s.id`,
          [id, ...profile.sourceIds],
        )
      : [];
    const games = profile.sourceIds.length
      ? (db.value<number>(
          `SELECT COUNT(*) FROM player_games WHERE source_id IN (${placeholders(profile.sourceIds.length)})`,
          profile.sourceIds,
        ) ?? 0)
      : 0;
    out.push({
      id: row.id,
      slug: row.slug,
      displayName: row.display_name,
      visibility: row.visibility,
      owner: row.owner_user_id !== null && row.owner_username !== null ? { id: row.owner_user_id, username: row.owner_username } : null,
      sources: sources.map(s => ({
        kind: s.kind,
        key: s.key,
        displayName: s.display_name,
        title: isTitle(s.title) ? (s.title as Title) : null,
        country: s.country,
      })),
      gameCount: games,
      lastUpdated: maxOrNull(sources.map(s => s.last_synced_at)),
      bookmarked: isBookmarked(db, viewer, row.id),
    });
  }
  return out;
}

/** Most profiles a list returns. */
export const MAX_LIST = 500;
/** "Recently viewed" keeps this many. */
export const MAX_RECENT = 50;

/** `GET /api/profiles?scope=` (`mine` and `recent` need a signed-in viewer: 401 otherwise). */
export function listProfiles(db: Db, scope: ProfileListQuery['scope'], viewer: AuthUser | null): ProfileSummary[] {
  let ids: Id[];
  switch (scope) {
    case 'mine':
      if (!viewer) throw new HttpError(401, 'unauthorized', 'Sign in to see your profiles');
      ids = db
        .all<{ id: Id }>('SELECT id FROM profiles WHERE owner_user_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?', [viewer.id, MAX_LIST])
        .map(r => r.id);
      break;
    case 'public':
      ids = db
        .all<{ id: Id }>("SELECT id FROM profiles WHERE visibility = 'public' ORDER BY views DESC, updated_at DESC, id DESC LIMIT ?", [MAX_LIST])
        .map(r => r.id);
      break;
    case 'recent':
      if (!viewer) throw new HttpError(401, 'unauthorized', 'Sign in to see recently viewed profiles');
      ids = db
        .all<{ profile_id: Id }>('SELECT profile_id FROM profile_views WHERE user_id = ? ORDER BY viewed_at DESC LIMIT ?', [
          viewer.id,
          MAX_RECENT,
        ])
        .map(r => r.profile_id);
      break;
  }
  return profileSummaries(db, ids, viewer);
}

/** `GET /api/bookmarks`: most recent first. */
export function listBookmarks(db: Db, viewer: AuthUser): ProfileSummary[] {
  const ids = db
    .all<{ profile_id: Id }>('SELECT profile_id FROM bookmarks WHERE user_id = ? ORDER BY created_at DESC, profile_id DESC', [viewer.id])
    .map(r => r.profile_id);
  return profileSummaries(db, ids, viewer);
}

/** `PUT` (on) / `DELETE` (off) `/api/profiles/:slug/bookmark`. */
export function setBookmark(db: Db, profile: ViewableProfile, viewer: AuthUser, on: boolean): BookmarkResponse {
  if (on) {
    db.run('INSERT INTO bookmarks (user_id, profile_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', [
      viewer.id,
      profile.id,
      Date.now(),
    ]);
  } else db.run('DELETE FROM bookmarks WHERE user_id = ? AND profile_id = ?', [viewer.id, profile.id]);
  return { bookmarked: on };
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/** A view counts once per viewer per 30 minutes of inactivity. */
export const VIEW_COUNT_WINDOW_MS = 30 * 60_000;
/** `profile_views.viewed_at` is rewritten at most once a minute per viewer and profile. */
export const VIEW_TOUCH_MS = 60_000;
const ANON_VIEW_CAP = 10_000;

/** In-memory throttle for anonymous views (per IP and profile; bounded). One per app. */
export class AnonymousViews {
  readonly #seen = new Map<string, number>();

  /** True when this visit counts as a new view. */
  hit(ip: string, profileId: Id, now: number): boolean {
    const key = `${profileId}|${ip}`;
    const last = this.#seen.get(key);
    this.#seen.delete(key);
    this.#seen.set(key, now);
    if (this.#seen.size > ANON_VIEW_CAP) {
      const oldest = this.#seen.keys().next().value;
      if (oldest !== undefined) this.#seen.delete(oldest);
    }
    return last === undefined || now - last >= VIEW_COUNT_WINDOW_MS;
  }
}

/**
 * Records that `viewer` opened the profile: `profile_views` (the "recent" list) for signed-in
 * viewers, and the `views` counter — once per viewer per `VIEW_COUNT_WINDOW_MS`, never for the
 * owner's own visits.
 */
export function recordView(
  db: Db,
  profile: ViewableProfile,
  viewer: AuthUser | null,
  anon: { views: AnonymousViews; ip: string },
  now = Date.now(),
): void {
  const isOwner = viewer !== null && viewer.id === profile.ownerUserId;
  if (!viewer) {
    if (anon.views.hit(anon.ip, profile.id, now)) db.run('UPDATE profiles SET views = views + 1 WHERE id = ?', [profile.id]);
    return;
  }
  const last = db.value<EpochMs>('SELECT viewed_at FROM profile_views WHERE user_id = ? AND profile_id = ?', [viewer.id, profile.id]);
  if (last !== undefined && now - last < VIEW_TOUCH_MS) return;
  db.tx(() => {
    db.run(
      `INSERT INTO profile_views (user_id, profile_id, viewed_at) VALUES (?, ?, ?)
       ON CONFLICT (user_id, profile_id) DO UPDATE SET viewed_at = excluded.viewed_at`,
      [viewer.id, profile.id, now],
    );
    if (!isOwner && (last === undefined || now - last >= VIEW_COUNT_WINDOW_MS)) {
      db.run('UPDATE profiles SET views = views + 1 WHERE id = ?', [profile.id]);
    }
    // Keep the per-user history bounded.
    db.run(
      `DELETE FROM profile_views WHERE user_id = ? AND profile_id NOT IN
         (SELECT profile_id FROM profile_views WHERE user_id = ? ORDER BY viewed_at DESC LIMIT ?)`,
      [viewer.id, viewer.id, MAX_RECENT * 2],
    );
  });
}

// ---------------------------------------------------------------------------
// Create, edit, delete
// ---------------------------------------------------------------------------

/** A free slug: `base`, else `base-2`, `base-3`, … (at most 64 characters). */
export function uniqueSlug(db: Db, base: string, exceptProfileId: Id | null = null): string {
  const taken = (s: string): boolean =>
    db.value('SELECT 1 FROM profiles WHERE slug = ? AND id IS NOT ?', [s, exceptProfileId]) !== undefined;
  if (!taken(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const suffix = `-${n}`;
    const s = `${base.slice(0, 64 - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (!taken(s)) return s;
  }
  for (;;) {
    const suffix = `-${Math.random().toString(36).slice(2, 10)}`;
    const s = `${base.slice(0, 64 - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (!taken(s)) return s;
  }
}

/** Identity of a requested source before resolving it (usernames are case-insensitive). */
const inputIdentity = (s: NewSourceInput): string => {
  const key = s.key.trim();
  return s.kind === 'fide' ? `fide|${key}` : `${s.kind}|${s.databaseId ?? ''}|${playerKey(key)}`;
};

/** Resolves every requested source (upstream checks run one at a time) and drops duplicates. */
async function resolveAll(ctx: ProfilesCtx, viewer: AuthUser, inputs: readonly NewSourceInput[]): Promise<ResolvedSource[]> {
  const out: ResolvedSource[] = [];
  const asked = new Set<string>();
  for (const [i, input] of inputs.entries()) {
    const id = inputIdentity(input);
    if (asked.has(id)) continue;
    asked.add(id);
    const r = await resolveSource({ db: ctx.db, upstream: ctx.upstream, viewer }, input, i);
    if (!out.some(o => o.kind === r.kind && o.key === r.key)) out.push(r);
  }
  return out;
}

/**
 * After sources were attached: PGN and FIDE sources pick up the games already stored (synchronous,
 * idempotent), Lichess / Chess.com sources that were never synced, or not within the update
 * cooldown, get their sync queued.
 */
function startSources(db: Db, settings: InstanceSettings, viewer: AuthUser, attached: ReadonlyArray<{ id: Id; created: boolean }>): JobInfo[] {
  const jobs: JobInfo[] = [];
  const now = Date.now();
  for (const { id, created } of attached) {
    const src = db.get<{ kind: SourceKind; last_synced_at: EpochMs | null }>('SELECT kind, last_synced_at FROM sources WHERE id = ?', [id]);
    if (!src) continue;
    if (src.kind === 'pgn' || src.kind === 'fide') {
      if (created || src.last_synced_at === null) {
        rebuildPlayerGames(db, id);
        db.run('UPDATE sources SET last_synced_at = ?, last_sync_error = NULL WHERE id = ?', [now, id]);
      }
      continue;
    }
    const stale = src.last_synced_at === null || now - src.last_synced_at >= settings.updateCooldownMinutes * 60_000;
    if (stale) jobs.push(enqueueSync(db, id, { userId: viewer.id, priority: viewer.role === 'admin' ? JOB_PRIORITY.high : JOB_PRIORITY.manual }));
  }
  return jobs;
}

/** `POST /api/profiles`: validates the accounts, creates the profile and queues the first syncs. */
export async function createProfile(ctx: ProfilesCtx, viewer: AuthUser, body: CreateProfileRequest): Promise<ViewableProfile> {
  const { db } = ctx;
  const resolved = await resolveAll(ctx, viewer, body.sources);
  if (body.slug !== undefined && db.value('SELECT 1 FROM profiles WHERE slug = ?', [body.slug]) !== undefined) {
    throw conflict(`The address "${body.slug}" is taken`, { field: 'slug' });
  }
  const now = Date.now();
  const { profileId, attached } = db.tx(() => {
    const slug = body.slug ?? uniqueSlug(db, slugify(body.displayName));
    const profileId = db.run(
      `INSERT INTO profiles (slug, display_name, owner_user_id, visibility, auto_refresh, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [slug, body.displayName, viewer.id, body.visibility ?? 'private', body.autoRefresh ?? false, now, now],
    ).lastInsertRowid;
    const attached = resolved.map(r => insertSource(db, r));
    for (const [i, a] of attached.entries()) {
      db.run('INSERT OR IGNORE INTO profile_sources (profile_id, source_id, hidden, position) VALUES (?, ?, 0, ?)', [profileId, a.id, i]);
    }
    return { profileId, attached };
  });
  startSources(db, readSettings(db, ctx.config), viewer, attached);
  return loadProfileByIdForViewer(db, profileId, viewer);
}

/** `PATCH /api/profiles/:slug`. Returns the updated profile (its slug may have changed). */
export function updateProfile(db: Db, profile: ViewableProfile, viewer: AuthUser, patch: UpdateProfileRequest): ViewableProfile {
  requireEditor(profile);
  db.tx(() => {
    const sets: string[] = [];
    const params: Array<string | number | boolean> = [];
    if (patch.displayName !== undefined) {
      sets.push('display_name = ?');
      params.push(patch.displayName);
    }
    if (patch.slug !== undefined && patch.slug !== profile.slug) {
      if (db.value('SELECT 1 FROM profiles WHERE slug = ? AND id != ?', [patch.slug, profile.id]) !== undefined) {
        throw conflict(`The address "${patch.slug}" is taken`, { field: 'slug' });
      }
      sets.push('slug = ?');
      params.push(patch.slug);
    }
    if (patch.visibility !== undefined) {
      sets.push('visibility = ?');
      params.push(patch.visibility);
    }
    if (patch.autoRefresh !== undefined) {
      sets.push('auto_refresh = ?');
      params.push(patch.autoRefresh);
    }
    if (patch.hiddenSourceIds !== undefined) {
      const own = new Set(db.all<{ source_id: Id }>('SELECT source_id FROM profile_sources WHERE profile_id = ?', [profile.id]).map(r => r.source_id));
      const unknown = patch.hiddenSourceIds.filter(id => !own.has(id));
      if (unknown.length) {
        throw validationError(`Source ${unknown[0]} is not part of this profile`, {
          issues: [{ path: 'hiddenSourceIds', message: `not in this profile: ${unknown.join(', ')}` }],
        });
      }
      const hidden = new Set(patch.hiddenSourceIds);
      for (const id of own) db.run('UPDATE profile_sources SET hidden = ? WHERE profile_id = ? AND source_id = ?', [hidden.has(id), profile.id, id]);
    }
    sets.push('updated_at = ?');
    params.push(Date.now());
    db.run(`UPDATE profiles SET ${sets.join(', ')} WHERE id = ?`, [...params, profile.id]);
  });
  return loadProfileByIdForViewer(db, profile.id, viewer);
}

/** Games larger clean-ups hand to the background (see the module comment). */
export const INLINE_GC_LIMIT = 1000;
const GC_BATCH = 250;

/**
 * Deletes the given games when nothing references them any more: no `player_games` row and no
 * database. Runs in short transactions and yields between them; stops early when `signal`
 * aborts. Returns the number deleted.
 */
export async function collectOrphanGames(db: Db, gameIds: readonly Id[], signal?: AbortSignal): Promise<number> {
  let deleted = 0;
  for (let i = 0; i < gameIds.length; i += GC_BATCH) {
    // Stopped (shutdown): the next `sweepOrphans` with `scanGames` finds the rest.
    if (signal?.aborted) break;
    deleted += collectBatch(db, gameIds.slice(i, i + GC_BATCH));
    if (i + GC_BATCH < gameIds.length) await yieldToLoop();
  }
  return deleted;
}

function collectBatch(db: Db, ids: readonly Id[]): number {
  return db.tx(() => {
    let n = 0;
    for (const id of ids) {
      n += db.run(
        `DELETE FROM games WHERE id = ? AND database_id IS NULL AND origin IN ('lichess', 'chesscom')
           AND NOT EXISTS (SELECT 1 FROM player_games WHERE game_id = ?)`,
        [id, id],
      ).changes;
    }
    return n;
  });
}

/**
 * Cancels the queued sync job of sources that are going away (call inside the transaction that
 * deletes them), so it neither waits in a lane nor counts in other profiles' queue positions,
 * through the jobs module's `cancelQueuedJobs`. A sync already running finishes on its own (see
 * the module comment). Returns the number cancelled.
 */
export function cancelQueuedSyncs(db: Db, sourceIds: readonly Id[], now = Date.now()): number {
  let n = 0;
  for (const id of sourceIds) n += cancelQueuedJobs(db, syncDedupeKey(id), now);
  return n;
}

/**
 * Deletes the sources no profile uses any more (call inside the transaction that detached them)
 * and cancels their queued syncs. Returns the ids of the Lichess / Chess.com games they had, for
 * `finishOrphanCleanup`.
 */
function dropOrphanSources(db: Db, sourceIds: readonly Id[]): Id[] {
  const games: Id[] = [];
  for (const id of sourceIds) {
    if (db.value('SELECT 1 FROM profile_sources WHERE source_id = ? LIMIT 1', [id]) !== undefined) continue;
    const kind = db.value<SourceKind>('SELECT kind FROM sources WHERE id = ?', [id]);
    if (kind === undefined) continue;
    if (kind === 'lichess' || kind === 'chesscom') {
      for (const r of db.all<{ game_id: Id }>('SELECT game_id FROM player_games WHERE source_id = ?', [id])) games.push(r.game_id);
    }
    cancelQueuedSyncs(db, [id]);
    db.run('DELETE FROM sources WHERE id = ?', [id]);
  }
  return games;
}

/** Ids scanned per step by `collectUnreferencedGames`. */
const SCAN_WINDOW = 5000;

/**
 * Deletes every Lichess / Chess.com game nothing references (no `player_games` row, no database):
 * games a sync stored after its source was deleted, and what a restart left of a background
 * clean-up. Scans the games by id in windows and yields between them; stops early when `signal`
 * aborts. Returns the number deleted.
 */
export async function collectUnreferencedGames(db: Db, signal?: AbortSignal): Promise<number> {
  let deleted = 0;
  const maxId = db.value<number>('SELECT MAX(id) FROM games') ?? 0;
  for (let from = 0; from < maxId; from += SCAN_WINDOW) {
    if (signal?.aborted) break;
    const ids = db
      .all<{ id: Id }>(
        `SELECT g.id FROM games g
          WHERE g.id > ? AND g.id <= ? AND g.database_id IS NULL AND g.origin IN ('lichess', 'chesscom')
            AND NOT EXISTS (SELECT 1 FROM player_games pg WHERE pg.game_id = g.id)`,
        [from, from + SCAN_WINDOW],
      )
      .map(r => r.id);
    for (let i = 0; i < ids.length; i += GC_BATCH) deleted += collectBatch(db, ids.slice(i, i + GC_BATCH));
    await yieldToLoop();
  }
  return deleted;
}

/**
 * The orphan policy for profiles that went away without `deleteProfile` (their owner was
 * deleted): drops every source no profile uses (cancelling its queued sync) and collects their
 * Lichess / Chess.com games; with `scanGames`, also every other game nothing references
 * (`collectUnreferencedGames`). Safe to run any time; yields between batches.
 */
export async function sweepOrphans(
  db: Db,
  opts: { scanGames?: boolean; signal?: AbortSignal } = {},
): Promise<{ sources: number; games: number }> {
  const { sources, games } = db.tx(() => {
    const ids = db
      .all<{ id: Id }>('SELECT s.id FROM sources s WHERE NOT EXISTS (SELECT 1 FROM profile_sources ps WHERE ps.source_id = s.id)')
      .map(r => r.id);
    return { sources: ids.length, games: dropOrphanSources(db, ids) };
  });
  let deleted = await collectOrphanGames(db, games, opts.signal);
  if (opts.scanGames && !opts.signal?.aborted) deleted += await collectUnreferencedGames(db, opts.signal);
  return { sources, games: deleted };
}

/** What a clean-up may use: a log for background failures and a stop signal (app shutdown). */
export interface CleanupOptions {
  log?: (err: unknown) => void;
  signal?: AbortSignal;
}

/** Collects orphaned games: inline when few, otherwise in the background. */
function finishOrphanCleanup(db: Db, gameIds: Id[], opts: CleanupOptions = {}): Promise<number> {
  if (gameIds.length <= INLINE_GC_LIMIT) {
    let n = 0;
    for (let i = 0; i < gameIds.length; i += GC_BATCH) n += collectBatch(db, gameIds.slice(i, i + GC_BATCH));
    return Promise.resolve(n);
  }
  const { log } = opts;
  return collectOrphanGames(db, gameIds, opts.signal).catch(err => {
    log?.(err);
    return 0;
  });
}

/**
 * `DELETE /api/profiles/:slug` (orphan policy in the module comment). `cleanup` settles when the
 * orphaned games are gone (already settled for small clean-ups); callers need not wait for it.
 */
export function deleteProfile(db: Db, profile: ViewableProfile, opts: CleanupOptions = {}): { cleanup: Promise<number> } {
  requireEditor(profile);
  const games = db.tx(() => {
    const sourceIds = db.all<{ source_id: Id }>('SELECT source_id FROM profile_sources WHERE profile_id = ?', [profile.id]).map(r => r.source_id);
    db.run('DELETE FROM profiles WHERE id = ?', [profile.id]);
    return dropOrphanSources(db, sourceIds);
  });
  return { cleanup: finishOrphanCleanup(db, games, opts) };
}

/** `POST /api/profiles/:slug/sources`. 409 when the source is already part of the profile. */
export async function addProfileSource(ctx: ProfilesCtx, profile: ViewableProfile, viewer: AuthUser, input: NewSourceInput): Promise<ViewableProfile> {
  requireEditor(profile);
  const { db } = ctx;
  const count = db.value<number>('SELECT COUNT(*) FROM profile_sources WHERE profile_id = ?', [profile.id]) ?? 0;
  if (count >= MAX_PROFILE_SOURCES) throw validationError(`A profile can combine at most ${MAX_PROFILE_SOURCES} accounts`);
  const resolved = await resolveSource({ db, upstream: ctx.upstream, viewer }, input);
  const attached = db.tx(() => {
    if (db.value('SELECT 1 FROM profiles WHERE id = ?', [profile.id]) === undefined) throw new HttpError(404, 'not_found', 'Profile not found');
    const a = insertSource(db, resolved);
    const added = db.run(
      `INSERT OR IGNORE INTO profile_sources (profile_id, source_id, hidden, position)
       VALUES (?1, ?2, 0, (SELECT COALESCE(MAX(position), -1) + 1 FROM profile_sources WHERE profile_id = ?1))`,
      [profile.id, a.id],
    );
    if (added.changes === 0) throw conflict('This account is already part of the profile');
    db.run('UPDATE profiles SET updated_at = ? WHERE id = ?', [Date.now(), profile.id]);
    return a;
  });
  startSources(db, readSettings(db, ctx.config), viewer, [attached]);
  return loadProfileByIdForViewer(db, profile.id, viewer);
}

/** `DELETE /api/profiles/:slug/sources/:sourceId` (orphan policy in the module comment). */
export function removeProfileSource(
  db: Db,
  profile: ViewableProfile,
  viewer: AuthUser,
  sourceId: Id,
  opts: CleanupOptions = {},
): { profile: ViewableProfile; cleanup: Promise<number> } {
  requireEditor(profile);
  const games = db.tx(() => {
    const removed = db.run('DELETE FROM profile_sources WHERE profile_id = ? AND source_id = ?', [profile.id, sourceId]);
    if (removed.changes === 0) throw new HttpError(404, 'not_found', 'This account is not part of the profile');
    db.run('UPDATE profiles SET updated_at = ? WHERE id = ?', [Date.now(), profile.id]);
    return dropOrphanSources(db, [sourceId]);
  });
  const cleanup = finishOrphanCleanup(db, games, opts);
  return { profile: loadProfileByIdForViewer(db, profile.id, viewer), cleanup };
}

// ---------------------------------------------------------------------------
// Manual update
// ---------------------------------------------------------------------------

/**
 * `POST /api/profiles/:slug/update`: queues a sync of every Lichess / Chess.com source (PGN and
 * FIDE sources pick up stored games right away). Owners wait `updateCooldownMinutes` between
 * updates (429 `cooldown`, `details.retryAt`); admins bypass it and get high priority.
 */
export function requestUpdate(db: Db, config: Config, profile: ViewableProfile, viewer: AuthUser): ProfileUpdateResponse {
  requireEditor(profile);
  const settings = readSettings(db, config);
  const now = Date.now();
  const row = profileRow(db, profile.id);
  const until = cooldownUntil(row, settings, viewer, now);
  if (until !== null) {
    throw new HttpError(429, 'cooldown', `This profile was updated recently; try again after ${new Date(until).toISOString()}`, {
      retryAt: until,
    });
  }
  const priority = viewer.role === 'admin' ? JOB_PRIORITY.high : JOB_PRIORITY.manual;
  const jobs = db.tx(() => {
    db.run('UPDATE profiles SET update_requested_at = ? WHERE id = ?', [now, profile.id]);
    const out: JobInfo[] = [];
    for (const s of db.all<{ id: Id; kind: SourceKind }>(
      `SELECT s.id, s.kind FROM profile_sources ps JOIN sources s ON s.id = ps.source_id WHERE ps.profile_id = ? ORDER BY s.id`,
      [profile.id],
    )) {
      if (s.kind === 'lichess' || s.kind === 'chesscom') out.push(enqueueSync(db, s.id, { userId: viewer.id, priority }));
      else {
        rebuildPlayerGames(db, s.id);
        db.run('UPDATE sources SET last_synced_at = ?, last_sync_error = NULL WHERE id = ?', [now, s.id]);
      }
    }
    return out;
  });
  const status = profileStatus(db, config, profile, viewer);
  return { jobs, queue: status.queue };
}
