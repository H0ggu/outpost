/**
 * THE CONTRACT: request and response types for every endpoint in docs/PLAN.md §6.
 *
 * Rules every module follows:
 * - The server returns exactly these shapes; the web app consumes them. If a shape must change,
 *   change it here first and keep both sides compiling.
 * - All timestamps are epoch **milliseconds** (UTC) — the same unit as the SQLite columns.
 *   Calendar dates are `YYYY-MM-DD` strings (`IsoDate`), months `YYYY-MM` (`IsoMonth`).
 * - Row ids are SQLite integers (`Id`). Slugs, usernames and codes are strings.
 * - Booleans are real booleans in JSON (SQLite stores 0/1; convert at the boundary).
 * - `null` means "known to be absent"; optional (`?`) fields may be omitted.
 * - Errors are `ApiErrorBody` with the matching HTTP status (PLAN §6).
 * - Every endpoint's response type is named in a doc comment here; mutations without a richer
 *   result answer `OkResponse` (`{ok:true}`, status 200). The full list is `MUTATION_RESPONSES`
 *   at the end of this file.
 * - Every stats-style query type is `ProfileFilters & <endpoint params>`; the endpoint params
 *   never reuse a filter key (`tc`, `src`, …), so `statsQuery(filters, params)` can't clash.
 * - String-literal unions only, never enums (Node type stripping, PLAN §1).
 */
import type {
  Color,
  GameResult,
  Outcome,
  Termination,
  TimeClass,
  Title,
  Wdl,
} from './chess.ts';
import type { ProfileFilters } from './filters.ts';

export type { Color, GameResult, Outcome, Termination, TimeClass, Title, Wdl } from './chess.ts';
export type { ProfileFilters } from './filters.ts';

// ===========================================================================
// Primitives
// ===========================================================================

/** SQLite row id. */
export type Id = number;
/** Epoch milliseconds, UTC. */
export type EpochMs = number;
/** Calendar date `YYYY-MM-DD`. */
export type IsoDate = string;
/** Calendar month `YYYY-MM`. */
export type IsoMonth = string;
/** Comma-separated UCI moves from the standard start position, standard castling (`e2e4,e7e5,g1f3`). */
export type UciLine = string;
/** X-FEN / FEN string. */
export type Fen = string;

/** A page of results. `page` is 1-based. */
export interface Paged {
  total: number;
  page: number;
  pageSize: number;
}

/** Paging query parameters (`page` is 1-based; `pageSize` defaults per endpoint). */
export interface PageQuery {
  page?: number;
  pageSize?: number;
}

// ===========================================================================
// Errors
// ===========================================================================

/** Machine-readable error codes. The HTTP status carries the class; the code carries the reason. */
export type ApiErrorCode =
  | 'bad_request' // 400 malformed input
  | 'validation' // 400 failed schema validation; `details` holds the issues
  | 'unauthorized' // 401 no or expired session
  | 'totp_required' // 401 password ok, TOTP code needed (login)
  | 'forbidden' // 403 signed in but not allowed
  | 'csrf' // 403 missing X-Outpost header or bad Origin
  | 'setup_required' // 403 no admin exists yet; go to /setup
  | 'not_found' // 404
  | 'conflict' // 409 duplicate slug/username, stale update
  | 'payload_too_large' // 413
  | 'unsupported_media_type' // 415
  | 'cooldown' // 429 profile update cooldown; `details.retryAt` (EpochMs)
  | 'rate_limited' // 429 request throttling
  | 'upstream_error' // 502 Lichess/Chess.com answered with an error
  | 'upstream_unavailable' // 503 upstream unreachable or token missing
  | 'internal'; // 500

/** Error payload inside `ApiErrorBody`. */
export interface ApiError {
  code: ApiErrorCode;
  message: string;
  details?: unknown;
}

/** Body of every non-2xx JSON response: `{error:{code,message}}`. */
export interface ApiErrorBody {
  error: ApiError;
}

/** `GET /api/health`. */
export interface HealthResponse {
  status: 'ok';
  version: string;
  uptimeSec: number;
}

/** Generic `{ok:true}` acknowledgement for mutations without a richer response. */
export interface OkResponse {
  ok: true;
}

// ===========================================================================
// Users, preferences and sessions (PLAN §6 "Session, account and admin", §10)
// ===========================================================================

/** User role. */
export type UserRole = 'admin' | 'user';
/** Who may create an account. */
export type SignupMode = 'closed' | 'invite' | 'open';
/** Site colour theme; `black` (true black for OLED) is the default. */
export type ThemeName = 'dark' | 'black' | 'light';

/** Free board images vendored from lila (web/public/lichess/board). */
export const BOARD_THEMES = ['brown', 'blue', 'green', 'purple', 'ic', 'wood4', 'maple', 'olive', 'grey', 'blue3'] as const;
/** Board theme name. */
export type BoardTheme = (typeof BOARD_THEMES)[number];

/** Free piece sets vendored from lila (web/public/lichess/piece). */
export const PIECE_SETS = [
  'cburnett',
  'merida',
  'chessnut',
  'fantasy',
  'spatial',
  'celtic',
  'kiwen-suwi',
  'firi',
  'rhosgfx',
  'mpchess',
  'pixel',
  'letter',
] as const;
/** Piece set name. */
export type PieceSet = (typeof PIECE_SETS)[number];

/** Free sound sets vendored from lila (web/public/lichess/sound), plus `silent`. */
export const SOUND_SETS = ['sfx', 'piano', 'nes', 'silent'] as const;
/** Sound set name. */
export type SoundSet = (typeof SOUND_SETS)[number];

/** Studio layout presets (PLAN §8.4). */
export const STUDIO_LAYOUTS = ['default', 'explorer', 'games', 'focus'] as const;
/** Studio layout preset. */
export type StudioLayout = (typeof STUDIO_LAYOUTS)[number];

/** Per-user UI preferences, `GET/PUT /api/me/prefs` (stored in `users.prefs_json`). */
export interface UserPrefs {
  theme: ThemeName;
  boardTheme: BoardTheme;
  pieceSet: PieceSet;
  soundSet: SoundSet;
  /** Colour W/D/L from the profile player's side (`player`) or as White/Black results (`white`). */
  winratePerspective: 'player' | 'white';
  /** Show times in the browser's zone or UTC. */
  timezone: 'local' | 'utc';
  studioLayout: StudioLayout;
}

/** Defaults applied to missing pref fields (anonymous visitors get these too). */
export const DEFAULT_PREFS: UserPrefs = {
  theme: 'black',
  boardTheme: 'brown',
  pieceSet: 'cburnett',
  soundSet: 'sfx',
  winratePerspective: 'player',
  timezone: 'local',
  studioLayout: 'default',
};

/** `PUT /api/me/prefs` body: any subset; the server merges and returns the full `UserPrefs`. */
export type UpdatePrefsRequest = Partial<UserPrefs>;

// Account policy: the one source of truth for the server's checks and the web forms (decision 10).

/** Shortest Outpost account username (characters). */
export const USERNAME_MIN_LENGTH = 2;
/** Longest Outpost account username (characters). */
export const USERNAME_MAX_LENGTH = 30;
/**
 * Outpost account usernames (setup, signup): `USERNAME_MIN_LENGTH`–`USERNAME_MAX_LENGTH`
 * characters, letters, digits, `_` and `-`, starting with a letter or digit. Unique
 * case-insensitively (`users.username COLLATE NOCASE`); the case typed at signup is kept for display.
 */
export const ACCOUNT_USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,29}$/;
/** Minimum password length (characters) for new passwords. */
export const PASSWORD_MIN_LENGTH = 8;
/** Maximum password length (characters). */
export const PASSWORD_MAX_LENGTH = 256;

/** The signed-in user as the browser sees it. */
export interface SessionUser {
  id: Id;
  username: string;
  role: UserRole;
  totpEnabled: boolean;
  prefs: UserPrefs;
}

/** `GET /api/session`. */
export interface SessionInfo {
  user: SessionUser | null;
  /** True until the first admin exists; the UI then sends everyone to /setup. */
  setupRequired: boolean;
  signupMode: SignupMode;
  /** Whether anonymous visitors may read public profiles and their stats. */
  anonymousBrowsing: boolean;
  version: string;
  /**
   * Where this instance's source code is published (env `SOURCE_URL`, AGPL-3.0 §13), or null when
   * the operator did not set one; the footer then links to the licence and NOTICE instead.
   */
  sourceUrl?: string | null;
}

/** `POST /api/setup`: create the first admin with the one-time setup token. Returns `LoginResponse`. */
export interface SetupRequest {
  token: string;
  username: string;
  password: string;
}

/** `POST /api/login`. Fails with `totp_required` when TOTP is on and `totp` is missing. */
export interface LoginRequest {
  username: string;
  password: string;
  totp?: string;
}

/** Response of login, setup and signup; the session cookie is set alongside. */
export interface LoginResponse {
  user: SessionUser;
}

/** `POST /api/signup` (`invite` required when signupMode is `invite`). Returns `LoginResponse`. */
export interface SignupRequest {
  username: string;
  password: string;
  invite?: string;
}

/** `POST /api/me/password`. */
export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

/**
 * `POST /api/me/totp/setup` body. `password` is the current password and is required (missing →
 * 400 `validation`, wrong → 403 `forbidden`, throttled with the other re-authentications), so a
 * session alone (e.g. a stolen cookie) cannot put somebody else's authenticator on the account.
 * `enable` then only needs a code for the pending secret this call created.
 */
export interface TotpSetupRequest {
  password: string;
}

/** `POST /api/me/totp/setup`: a pending secret; nothing changes until it is confirmed with `enable`. */
export interface TotpSetupResponse {
  /** Base32 secret for manual entry. */
  secret: string;
  /** `otpauth://totp/...` URI. */
  otpauthUrl: string;
  /** The URI as an inline SVG QR code (rendered server-side, no external requests). */
  qrSvg: string;
  /** The same QR code as a `data:image/png;base64,…` URL, for an `<img src>` (CSP allows `img-src data:`). */
  qrDataUrl?: string;
  /** When the pending secret expires unless confirmed with `enable`. */
  expiresAt?: EpochMs;
}

/** `POST /api/me/totp/enable`: confirm the pending secret with a current code. */
export interface TotpEnableRequest {
  code: string;
}

/**
 * `POST /api/me/totp/disable`. Either proof is enough: the current password **or** a current code
 * (send an empty string for the one you don't use).
 */
export interface TotpDisableRequest {
  password: string;
  code: string;
}

/** One row of `GET /api/me/sessions`. */
export interface SessionRow {
  /** Opaque id (hex of the stored hash); use it with `DELETE /api/me/sessions/:id`. */
  id: string;
  createdAt: EpochMs;
  lastSeenAt: EpochMs;
  expiresAt: EpochMs;
  ip: string | null;
  userAgent: string | null;
  /** The session making this request. */
  current: boolean;
}

/** `GET /api/me/sessions`. */
export interface SessionsResponse {
  sessions: SessionRow[];
}

// ===========================================================================
// Admin (PLAN §6, §7 scheduling)
// ===========================================================================

/** Where the masters explorer reads from: Lichess, or a local reference database by id. */
export type MastersSource = 'lichess' | `reference:${number}`;

/** A secret setting as shown to the admin (never the full value). */
export interface MaskedSecret {
  /** Whether a value is configured (from env or the UI). */
  set: boolean;
  /** e.g. `lip_…a1b2`, or null when unset. */
  masked: string | null;
  /** True when the env var provides it (env wins; the UI cannot override). */
  fromEnv: boolean;
}

/** `GET /api/admin/settings`; also the response of `PUT`. */
export interface AdminSettings {
  signupMode: SignupMode;
  anonymousBrowsing: boolean;
  lichessToken: MaskedSecret;
  /** Effective contact for the upstream User-Agent (env wins), or null when unset. */
  chesscomContact: string | null;
  /** True when `CHESSCOM_CONTACT` is set in env (env wins). */
  chesscomContactFromEnv: boolean;
  /** Hour (0–23, UTC) of the daily auto refresh. */
  autoRefreshHourUtc: number;
  /** Minimum minutes between manual updates of one profile. */
  updateCooldownMinutes: number;
  /** Months of history for a source's first import; 0 = everything. */
  initialSyncMonths: number;
  mastersSource: MastersSource;
  /**
   * Import finished official Lichess broadcast rounds into the built-in "Lichess broadcasts"
   * reference database automatically (needs the Lichess token; default off, decision 22). The
   * server always sends it; it stays optional so clients can treat its absence as "off".
   */
  broadcastAutoImport?: boolean;
}

/**
 * `PUT /api/admin/settings` body: any subset. Returns `AdminSettings`. `null` clears the UI-set
 * `lichessToken` / `chesscomContact` (an env value still wins).
 */
export interface UpdateAdminSettingsRequest {
  signupMode?: SignupMode;
  anonymousBrowsing?: boolean;
  lichessToken?: string | null;
  chesscomContact?: string | null;
  autoRefreshHourUtc?: number;
  updateCooldownMinutes?: number;
  initialSyncMonths?: number;
  mastersSource?: MastersSource;
  /** See `AdminSettings.broadcastAutoImport`. */
  broadcastAutoImport?: boolean;
}

/** One row of `GET /api/admin/users`. */
export interface AdminUser {
  id: Id;
  username: string;
  role: UserRole;
  disabled: boolean;
  totpEnabled: boolean;
  createdAt: EpochMs;
  /** Most recent session activity, or null if never signed in. */
  lastSeenAt: EpochMs | null;
  profileCount: number;
}

/** `GET /api/admin/users`. */
export interface AdminUsersResponse {
  users: AdminUser[];
}

/** `PATCH /api/admin/users/:id` → `AdminUser`. `password` resets it and signs the user out everywhere. */
export interface UpdateAdminUserRequest {
  role?: UserRole;
  disabled?: boolean;
  password?: string;
  /** Turn off TOTP for a locked-out user. */
  resetTotp?: boolean;
}

/** An invite code (`GET/POST /api/admin/invites`). */
export interface Invite {
  code: string;
  createdBy: { id: Id; username: string } | null;
  createdAt: EpochMs;
  expiresAt: EpochMs | null;
  usedBy: { id: Id; username: string } | null;
  usedAt: EpochMs | null;
}

/** `GET /api/admin/invites`. */
export interface InvitesResponse {
  invites: Invite[];
}

/** `POST /api/admin/invites` body. Returns the new `Invite`. */
export interface CreateInviteRequest {
  /** Days until expiry; omitted = never expires. */
  expiresInDays?: number;
}

/**
 * One upstream reachability probe in `AdminStatus`. tests.stockfishchess.org (the NNUE download
 * host) is deliberately not probed: it is a volunteer-run server (decision 11).
 */
export interface UpstreamStatus {
  name: 'lichess' | 'lichess-explorer' | 'chesscom' | 'lichess-database';
  url: string;
  ok: boolean;
  status: number | null;
  latencyMs: number | null;
  error: string | null;
}

/**
 * Outcome of the Lichess token check (`GET https://lichess.org/api/account` with the token):
 * `missing` none configured, `valid` accepted, `invalid` refused (401/403), `unknown` Lichess could
 * not be asked (network error, timeout, rate limit, 5xx).
 */
export type LichessTokenState = 'missing' | 'valid' | 'invalid' | 'unknown';

/** `GET /api/admin/status`. */
export interface AdminStatus {
  version: string;
  nodeVersion: string;
  sqliteVersion: string;
  uptimeSec: number;
  dataDir: string;
  /** Database file plus its write-ahead log (`outpost.db` + `outpost.db-wal`). */
  dbSizeBytes: number;
  lichessToken: {
    configured: boolean;
    /** null when not checked or not configured. */
    valid: boolean | null;
    userId: string | null;
    scopes: string[];
    state?: LichessTokenState;
    /** Why the check failed (`invalid` / `unknown`), else null. */
    error?: string | null;
    /** True when the token comes from the LICHESS_TOKEN env var. */
    fromEnv?: boolean;
  };
  upstream: UpstreamStatus[];
  /** When the token check and upstream probes ran (they are cached for about a minute). */
  checkedAt?: EpochMs;
  /** Number of jobs in each status. */
  jobs?: Record<JobStatus, number>;
  counts: {
    users: number;
    profiles: number;
    sources: number;
    games: number;
    referenceGames: number;
    positions: number;
    queuedJobs: number;
  };
}

// ===========================================================================
// Jobs (PLAN §7)
// ===========================================================================

/** Job state. */
export type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';
/** Worker lane: one in-process worker per lane, each upstream rate-limited separately. */
export type JobLane = 'lichess' | 'chesscom' | 'local';
/**
 * Job kinds. Payloads (see `JobPayloads`) are owned by the jobs/sync, reference and databases modules.
 * - `sync`: import new games for one source (lane follows the source kind).
 * - `geo`: look up opponents' country/title (Lichess batch or Chess.com serial).
 * - `pgnImport`: import a PGN upload into a user database.
 * - `referenceImport`: import a PGN file or URL into a reference database.
 * - `broadcastMonth`: import one database.lichess.org broadcast month (`.pgn.zst`).
 * - `broadcastRound`: import a finished Lichess broadcast round into the reference DB.
 * - `rebuild`: recompute derived data (positions, openings, player_games) for a source or database.
 */
export type JobKind = 'sync' | 'geo' | 'pgnImport' | 'referenceImport' | 'broadcastMonth' | 'broadcastRound' | 'rebuild';

/** Payload of each job kind (stored as `jobs.payload_json`). */
export interface JobPayloads {
  sync: { sourceId: Id; full?: boolean };
  geo: { kind: 'lichess' | 'chesscom'; keys: string[] };
  pgnImport: { databaseId: Id; file: string; originalName: string | null };
  referenceImport: { databaseId: Id; file?: string; url?: string };
  broadcastMonth: { databaseId: Id; month: IsoMonth };
  broadcastRound: { databaseId: Id; roundId: string };
  rebuild: { sourceId?: Id; databaseId?: Id };
}

/** Progress of a running or finished job (`jobs.progress_json`). */
export interface JobProgress {
  /** Units done so far (games, months, users…). */
  done: number;
  /** Expected total, or null when unknown (streams). */
  total: number | null;
  /** Short human-readable status, e.g. "2024-05 (312 games)". */
  message: string | null;
  /** Named counters, e.g. `{imported, duplicates, skipped}` for imports. */
  counts?: Record<string, number>;
}

/** A job as shown in the UI (`/api/admin/jobs`, `/api/jobs/mine`, embedded in other responses). */
export interface JobInfo {
  id: Id;
  kind: JobKind;
  lane: JobLane;
  status: JobStatus;
  priority: number;
  /** Human-readable label, e.g. "Sync lichess:drnykterstein". */
  label: string;
  userId: Id | null;
  progress: JobProgress | null;
  error: string | null;
  createdAt: EpochMs;
  startedAt: EpochMs | null;
  finishedAt: EpochMs | null;
  /** 1-based position in its lane's queue while queued; 0 while running; null otherwise. */
  queuePosition: number | null;
}

/** `GET /api/admin/jobs` query. */
export interface AdminJobsQuery extends PageQuery {
  status?: JobStatus;
  kind?: JobKind;
  lane?: JobLane;
}

/** `GET /api/admin/jobs`. */
export interface AdminJobsPage extends Paged {
  jobs: JobInfo[];
  counts: Record<JobStatus, number>;
}

/** `GET /api/jobs/mine`: queued and running jobs relevant to me (my profiles, my imports). */
export interface MyJobsResponse {
  jobs: JobInfo[];
}

// ===========================================================================
// Sources and profiles (PLAN §4 sources/profiles, §6 "Search and profiles")
// ===========================================================================

/** Kind of sync identity behind a profile. */
export type SourceKind = 'lichess' | 'chesscom' | 'fide' | 'pgn';
/** Profile or database visibility. */
export type Visibility = 'private' | 'public';
/** Where a stored game came from (`games.origin`). */
export type GameOrigin = 'lichess' | 'chesscom' | 'pgn' | 'reference';

/** Sync state of a source, combined from `sources` and its jobs. */
export type SyncState = 'never' | 'queued' | 'running' | 'idle' | 'error';

/** Sync status of one source. */
export interface SourceSyncStatus {
  state: SyncState;
  lastSyncedAt: EpochMs | null;
  /** Last error message (kept until the next successful sync). */
  lastError: string | null;
  /** Progress of the queued/running job. */
  progress: JobProgress | null;
  /** 1-based queue position while queued, 0 while running, null otherwise. */
  queuePosition: number | null;
  jobId: Id | null;
}

/** Current rating of a source in one time class. */
export interface CurrentRating {
  timeClass: TimeClass;
  rating: number;
  /** Games in this time class in Outpost's data. */
  games: number;
  /** Lichess RD / Chess.com Glicko RD when known. */
  rd: number | null;
  /** True when the site marks it provisional. */
  provisional: boolean;
}

/** One source inside a profile header. */
export interface SourceSummary {
  id: Id;
  kind: SourceKind;
  /** Lowercase username, FIDE id, or `<databaseId>:<playerKey(name)>` for pgn (server `pgnSourceKey`). */
  key: string;
  displayName: string;
  /** Link to the account on its site (null for pgn sources). */
  url: string | null;
  title: Title | null;
  /** ISO 3166-1 alpha-2. */
  country: string | null;
  /** Hidden from viewers other than the owner (`profile_sources.hidden`). */
  hidden: boolean;
  /** For `pgn` sources: the database it reads from. */
  databaseId: Id | null;
  gameCount: number;
  ratings: CurrentRating[];
  /** FIDE standard/rapid/blitz ratings when known (FIDE sources, Lichess profile fields). */
  fide: { standard: number | null; rapid: number | null; blitz: number | null } | null;
  sync: SourceSyncStatus;
}

/**
 * A source to attach to a profile (create / add). `key` is what the user picked, never a stored key:
 * - `lichess` / `chesscom`: the username (any case; stored lowercase);
 * - `fide`: the FIDE id;
 * - `pgn`: the player's name exactly as written in the PGN's White/Black tag, with `databaseId`
 *   (required). The server stores `sources.key = pgnSourceKey(databaseId, key)`
 *   (server/src/chess/store.ts, the only builder of pgn keys) and `display_name = key`.
 */
export interface NewSourceInput {
  kind: SourceKind;
  key: string;
  /** For `pgn` only (required there): which database. */
  databaseId?: Id;
}

/** A profile in lists, search results and bookmarks. */
export interface ProfileSummary {
  id: Id;
  slug: string;
  displayName: string;
  visibility: Visibility;
  owner: { id: Id; username: string } | null;
  /** Visible sources only (kind + display name), for badges. */
  sources: Array<{ kind: SourceKind; key: string; displayName: string; title: Title | null; country: string | null }>;
  gameCount: number;
  lastUpdated: EpochMs | null;
  bookmarked: boolean;
}

/** `GET /api/profiles` query. `recent` = profiles I viewed recently. */
export interface ProfileListQuery {
  scope: 'mine' | 'public' | 'recent';
}

/** `GET /api/profiles`, `GET /api/bookmarks`. */
export interface ProfileListResponse {
  profiles: ProfileSummary[];
}

/** `POST /api/profiles`. Returns `ProfileHeader`. Slug defaults to a slugified display name. */
export interface CreateProfileRequest {
  displayName: string;
  slug?: string;
  visibility?: Visibility;
  autoRefresh?: boolean;
  sources: NewSourceInput[];
}

/** `PATCH /api/profiles/:slug`. Returns `ProfileHeader`. */
export interface UpdateProfileRequest {
  displayName?: string;
  /** New slug (`[a-z0-9-]{2,64}`); the old one stops working. */
  slug?: string;
  visibility?: Visibility;
  autoRefresh?: boolean;
  /** Complete list of hidden source ids (replaces the current set). */
  hiddenSourceIds?: Id[];
}

/** `POST /api/profiles/:slug/sources` body. Returns `ProfileHeader`. */
export type AddSourceRequest = NewSourceInput;

/** Update/cooldown state of a profile. */
export interface ProfileQueueInfo {
  /** Some source is queued or running. */
  busy: boolean;
  /** Earliest time a manual update is allowed again, or null if allowed now. */
  cooldownUntil: EpochMs | null;
  /** Best (lowest) queue position across the profile's queued jobs, or null. */
  queuePosition: number | null;
}

/** `GET /api/profiles/:slug`: everything the profile header and tabs need. */
export interface ProfileHeader {
  id: Id;
  slug: string;
  displayName: string;
  visibility: Visibility;
  autoRefresh: boolean;
  owner: { id: Id; username: string } | null;
  /** The viewer may edit/delete/update this profile (owner or admin). */
  canEdit: boolean;
  bookmarked: boolean;
  /** Sources visible to the viewer (the owner also sees hidden ones, flagged `hidden`). */
  sources: SourceSummary[];
  totals: Wdl & { games: number };
  lastUpdated: EpochMs | null;
  queue: ProfileQueueInfo;
  views: number;
  createdAt: EpochMs;
}

/** `PUT` / `DELETE /api/profiles/:slug/bookmark`: the new state. */
export interface BookmarkResponse {
  bookmarked: boolean;
}

/** `POST /api/profiles/:slug/update` → enqueued sync jobs (fails with `cooldown` when too soon). */
export interface ProfileUpdateResponse {
  jobs: JobInfo[];
  queue: ProfileQueueInfo;
}

/** `GET /api/profiles/:slug/status`: cheap polling endpoint while syncing. */
export interface ProfileStatus {
  sources: Array<{ sourceId: Id; sync: SourceSyncStatus; gameCount: number }>;
  queue: ProfileQueueInfo;
  lastUpdated: EpochMs | null;
}

// ===========================================================================
// Search (PLAN §6, unified search)
// ===========================================================================

/** `GET /api/search?q=`. */
export interface SearchQuery {
  q: string;
}

/** A Lichess or Chess.com account found by search. */
export interface ExternalPlayerHit {
  kind: 'lichess' | 'chesscom';
  /** Username in display case. */
  username: string;
  title: Title | null;
  /** Whether the account is confirmed to exist upstream (Chess.com exact check, Lichess autocomplete). */
  exists: boolean;
  /** Found in Outpost's own index of known usernames (games already imported). */
  known: boolean;
  /** A visible local profile that already includes this account. */
  profileSlug: string | null;
}

/** `GET /api/search`. Each list is independent; an upstream failure leaves its list empty. */
export interface SearchResults {
  q: string;
  profiles: ProfileSummary[];
  lichess: ExternalPlayerHit[];
  chesscom: ExternalPlayerHit[];
  reference: ReferencePlayer[];
  /** Sites whose upstream lookup failed this time; their lists then hold local hits only. */
  unavailable?: Array<'lichess' | 'chesscom'>;
}

// ===========================================================================
// Stats (PLAN §6 "Stats" — every endpoint also takes ProfileFilters)
// ===========================================================================

/** The opponent in a `GameRow`. */
export interface GameRowOpponent {
  name: string;
  key: string;
  rating: number | null;
  title: Title | null;
  /** The site the opponent played on (their source kind). */
  kind: SourceKind;
  country: string | null;
}

/** One game from the profile player's side (games tab, latest games, explorer games). */
export interface GameRow {
  id: Id;
  origin: GameOrigin;
  /** External link (Lichess/Chess.com game page), null for PGN games. */
  url: string | null;
  sourceId: Id;
  color: Color;
  outcome: Outcome;
  result: GameResult;
  termination: Termination;
  timeClass: TimeClass;
  /** PGN TimeControl, e.g. `180+2`. */
  timeControl: string | null;
  rated: boolean;
  startedAt: EpochMs | null;
  /** Null only for PGN games without a usable date. */
  endedAt: EpochMs | null;
  /** The player's rating before the game. */
  rating: number | null;
  /** The player's rating after the game, when known. */
  ratingAfter: number | null;
  opponent: GameRowOpponent;
  plies: number;
  eco: string | null;
  openingName: string | null;
  /** The player's accuracy (0–100) when the site computed one. */
  accuracy: number | null;
  event: string | null;
}

/** `GET /api/profiles/:slug/overview` query. */
export type OverviewQuery = ProfileFilters;

/** `GET /api/profiles/:slug/games` and `games.pgn` query (pageSize defaults to 20; `.pgn` ignores paging). */
export type GamesQuery = ProfileFilters & PageQuery;

/** `GET /api/profiles/:slug/games`. */
export interface GamesPage extends Paged {
  summary: Wdl;
  games: GameRow[];
}

/** Per-time-class line of the overview table. */
export interface OverviewTimeClassRow extends Wdl {
  timeClass: TimeClass;
  games: number;
  /** Current rating per source in this time class. */
  ratings: Array<{ sourceId: Id; rating: number }>;
}

/** Termination × result cell counts for the overview. */
export interface TerminationRow extends Wdl {
  termination: Termination;
}

/** A rating time series (`[t, rating]` points, ascending t). */
export interface RatingSeries {
  sourceId: Id;
  timeClass: TimeClass;
  points: Array<[EpochMs, number]>;
}

/** One day of activity. `score` is in [0,1], null when no games. */
export interface ActivityDay {
  date: IsoDate;
  games: number;
  score: number | null;
}

/** An activity bucket (hour, weekday, grid cell). */
export interface ActivityCell {
  games: number;
  score: number | null;
}

/** `GET /api/profiles/:slug/overview`. */
export interface OverviewStats {
  totals: Wdl & { games: number };
  timeClasses: OverviewTimeClassRow[];
  byColor: { white: Wdl & { games: number }; black: Wdl & { games: number } };
  terminations: TerminationRow[];
  topOpenings: { white: OpeningRow[]; black: OpeningRow[] };
  /** The 5 latest games. */
  latestGames: GameRow[];
  /** Last 90 days, oldest first, one entry per day (zeros included). */
  activity: ActivityDay[];
  /** Last 365 days of rating points per source and time class. */
  ratingSparkline: RatingSeries[];
}

/**
 * `order: 'best' | 'worst'` only ranks openings with at least this many games (a higher `minGames`
 * raises it), so one lucky game does not top the table. The page says "(min N games)" (decision 34).
 */
export const OPENINGS_RANK_MIN_GAMES = 5;

/** Endpoint params of `GET /api/profiles/:slug/openings`. Move bounds are full moves (1–5 in the UI). */
export interface OpeningsParams {
  side?: 'white' | 'black' | 'both';
  order?: 'most' | 'best' | 'worst';
  minGames?: number;
  minMoves?: number;
  maxMoves?: number;
}

/** `GET /api/profiles/:slug/openings` query. */
export type OpeningsQuery = ProfileFilters & OpeningsParams;

/** One opening line in the openings table. */
export interface OpeningRow extends Wdl {
  eco: string;
  name: string;
  /** The named line (UCI csv) — click-through opens the explorer at it. */
  line: UciLine;
  /** The profile player's colour in these games. */
  color: Color;
  games: number;
  avgPly: number;
}

/** `GET /api/profiles/:slug/openings`. Lists are empty for a side not requested. */
export interface OpeningsResponse {
  white: OpeningRow[];
  black: OpeningRow[];
}

/** Endpoint params of `GET /api/profiles/:slug/opponents` (pageSize defaults to 20). */
export interface OpponentsParams extends PageQuery {
  view?: 'most' | 'titled';
}

/** `GET /api/profiles/:slug/opponents` query. */
export type OpponentsQuery = ProfileFilters & OpponentsParams;

/** One opponent row. */
export interface OpponentRow extends Wdl {
  key: string;
  name: string;
  kind: SourceKind;
  title: Title | null;
  country: string | null;
  games: number;
  /** Opponent's rating in the latest game against them. */
  lastRating: number | null;
  lastPlayed: EpochMs | null;
  /** A visible local profile containing this opponent, if any. */
  profileSlug: string | null;
}

/** `GET /api/profiles/:slug/opponents`. */
export interface OpponentsPage extends Paged {
  rows: OpponentRow[];
}

/** One termination line of the behaviour tables. */
export interface BehaviourRow {
  termination: Termination;
  count: number;
  /** Share of this outcome's games, 0–100. */
  pct: number;
  avgMoves: number;
}

/** `GET /api/profiles/:slug/behaviour` query. */
export type BehaviourQuery = ProfileFilters;

/** `GET /api/profiles/:slug/behaviour`: termination breakdown for wins, draws and losses. */
export interface BehaviourStats {
  w: BehaviourRow[];
  d: BehaviourRow[];
  l: BehaviourRow[];
}

/** One country on the world map. */
export interface WorldMapCountry extends Wdl {
  /** ISO 3166-1 alpha-2 (XK for Kosovo). */
  code: string;
  games: number;
  opponents: number;
}

/** `GET /api/profiles/:slug/worldmap` query. */
export type WorldMapQuery = ProfileFilters;

/** `GET /api/profiles/:slug/worldmap`. */
export interface WorldMapStats {
  countries: WorldMapCountry[];
  /** Games whose opponent country is unknown (not looked up yet, or no flag). */
  unknownGames: number;
  /** Opponents still queued for a country lookup. */
  pendingLookups: number;
}

/** Endpoint params of `GET /api/profiles/:slug/activity`: IANA zone for bucketing (default UTC). */
export interface ActivityParams {
  tz?: string;
}

/** `GET /api/profiles/:slug/activity` query. */
export type ActivityQuery = ProfileFilters & ActivityParams;

/**
 * `GET /api/profiles/:slug/activity`. Games dated before 1400 or after tomorrow (typos and
 * placeholder dates in PGNs) are left out. Games whose time of day is unknown (date-only PGN and
 * reference games) count in `days` and `byWeekday` but not in `byHour` and `grid`, so those totals
 * can be smaller.
 */
export interface ActivityStats {
  /** The zone used, in one canonical spelling (`asia/kolkata` → `Asia/Kolkata`). */
  tz: string;
  /**
   * Every day from the first to the last game in range, oldest first, zeros included. At most
   * 14,610 days (40 years): when the games span more, the days start at the first game of the
   * last 40 years.
   */
  days: ActivityDay[];
  /** 24 entries, local hour 0–23. */
  byHour: ActivityCell[];
  /** 7 entries, Monday = 0 … Sunday = 6. */
  byWeekday: ActivityCell[];
  /** `grid[weekday][hour]`, same indexing as above. */
  grid: ActivityCell[][];
}

/**
 * `GET /api/profiles/:slug/rating` query: just the filters. To chart one source or one time
 * class, narrow the filter's own `src` / `tc` (there are no separate `source`/`tc` params, which
 * would collide with the filter keys).
 */
export type RatingQuery = ProfileFilters;

/** Average ratings over the last `n` games (null `n` = all games). */
export interface RatingAverage {
  n: number | null;
  games: number;
  avgRating: number | null;
  avgOppRating: number | null;
  score: number | null;
}

/** `GET /api/profiles/:slug/rating`. */
export interface RatingStats {
  series: RatingSeries[];
  averages: RatingAverage[];
}

/** Most suggestions in an `EventsResponse`. */
export const EVENT_SUGGESTIONS_MAX = 20;

/**
 * `GET /api/profiles/:slug/events` query: event-name suggestions for the filters bar's `event`
 * field (decision 35). Takes only `q`, not the filters: suggestions cover every game of the
 * profile's sources the viewer may see.
 */
export interface EventsQuery {
  /**
   * Text typed so far (trimmed, at most 200 characters). Events containing it match,
   * case-insensitively like the `event` filter; events starting with it come first. Empty or
   * absent = the profile's most played events.
   */
  q?: string;
}

/** One event name with the number of the profile's games played in it. */
export interface EventSuggestion {
  name: string;
  games: number;
}

/**
 * `GET /api/profiles/:slug/events`: at most `EVENT_SUGGESTIONS_MAX` distinct `games.event` values
 * of the profile's visible sources, prefix matches first, then by games (most first) and name.
 * Selecting one sets the `event` filter, which matches by substring.
 */
export interface EventsResponse {
  events: EventSuggestion[];
}

// ===========================================================================
// Games (PLAN §6 "Games, explorer and proxies")
// ===========================================================================

/** One side of a stored game. */
export interface GamePlayer {
  name: string;
  key: string;
  rating: number | null;
  title: Title | null;
  fideId: string | null;
  accuracy: number | null;
}

/** A stored game with all metadata (`games` row). */
export interface GameDetail {
  id: Id;
  origin: GameOrigin;
  originId: string;
  url: string | null;
  databaseId: Id | null;
  white: GamePlayer;
  black: GamePlayer;
  result: GameResult;
  termination: Termination;
  timeClass: TimeClass;
  timeControl: string | null;
  rated: boolean;
  event: string | null;
  round: string | null;
  startedAt: EpochMs | null;
  /** Null only for PGN games without a usable date. */
  endedAt: EpochMs | null;
  plies: number;
  eco: string | null;
  openingName: string | null;
  /** Ply at which the named opening was recognised. */
  openingPly: number | null;
  /** Original PGN headers. */
  headers: Record<string, string>;
}

/** `GET /api/games/:id`. */
export interface GameResponse {
  game: GameDetail;
  pgn: string;
}

/** A game in a database or reference list (no player perspective). */
export interface DbGameRow {
  id: Id;
  origin: GameOrigin;
  url: string | null;
  white: { name: string; rating: number | null; title: Title | null };
  black: { name: string; rating: number | null; title: Title | null };
  result: GameResult;
  termination: Termination;
  timeClass: TimeClass;
  event: string | null;
  round: string | null;
  /** Null only for PGN games without a usable date. */
  endedAt: EpochMs | null;
  plies: number;
  eco: string | null;
  openingName: string | null;
}

// ===========================================================================
// Explorer (Lichess-compatible shapes; PLAN §6 and §8)
// ===========================================================================

/** Opening name attached to explorer responses and moves. */
export interface ExplorerOpening {
  eco: string;
  name: string;
}

/** A player inside an explorer game reference. */
export interface ExplorerGamePlayer {
  name: string;
  rating: number;
  title?: Title;
}

/**
 * A game reference in explorer responses (`topGames`, `recentGames`, `moves[].game`).
 * For Outpost data `id` is the Outpost game id prefixed `op` (e.g. `op123`); for proxied
 * Lichess data it is the Lichess id.
 */
export interface ExplorerGameRef {
  /** Move that led into this game from the requested position (in `topGames`/`recentGames`). */
  uci?: string;
  id: string;
  winner: Color | null;
  white: ExplorerGamePlayer;
  black: ExplorerGamePlayer;
  year: number;
  /** `YYYY-MM` (Lichess sends a string for lichess/player, sometimes null for masters). */
  month: string | null;
  speed?: string;
  mode?: 'rated' | 'casual';
}

/** One move row in the masters / lichess / reference explorers. */
export interface ExplorerMove {
  uci: string;
  san: string;
  averageRating: number;
  white: number;
  draws: number;
  black: number;
  game: ExplorerGameRef | null;
  opening: ExplorerOpening | null;
}

/** `GET /api/explorer/masters` and `/api/explorer/reference` (same shape as explorer.lichess.org/masters). */
export interface ExplorerMastersResponse {
  opening: ExplorerOpening | null;
  white: number;
  draws: number;
  black: number;
  moves: ExplorerMove[];
  topGames: ExplorerGameRef[];
}

/** `GET /api/explorer/lichess` (same shape as explorer.lichess.org/lichess). */
export interface ExplorerLichessResponse extends ExplorerMastersResponse {
  recentGames: ExplorerGameRef[];
  history?: Array<{ month: string; white: number; draws: number; black: number }>;
}

/** One move row in the player explorer. */
export interface ExplorerPlayerMove {
  uci: string;
  san: string;
  averageOpponentRating: number;
  /** Performance rating over these games. */
  performance: number;
  white: number;
  draws: number;
  black: number;
  game: ExplorerGameRef | null;
  opening: ExplorerOpening | null;
  /** Outpost extension: when this move was last played (epoch ms). Lila ignores it. */
  lastPlayed?: EpochMs;
}

/**
 * `GET /api/explorer/player` and `/api/explorer/f/<filters>/player`: Lichess-compatible NDJSON;
 * Outpost writes exactly one line with this object.
 */
export interface ExplorerPlayerResponse {
  opening: ExplorerOpening | null;
  /** Always 0 for Outpost data (indexing is done ahead of time). */
  queuePosition: number;
  white: number;
  draws: number;
  black: number;
  moves: ExplorerPlayerMove[];
  recentGames: ExplorerGameRef[];
}

/**
 * Who the player explorer reads: a profile slug, or `lichess:<user>`, `chesscom:<user>`,
 * `db:<databaseId>`, `ref:<fideId>`. Parse with `parsePlayerSpec` (filters.ts).
 */
export type ExplorerPlayerSpec = string;

/**
 * Query of the explorer endpoints, as lila sends it (PLAN §6).
 *
 * For Outpost data (player explorer, `/api/explorer/games`) lila's own settings — `speeds`, `modes`,
 * `since`, `until` — are ANDed with the Outpost filters from the `/f/<segment>/` path. Turn them into
 * conditions with `explorerQueryRestrictions` (filters.ts) only; never filter on the raw values:
 * lila always sends `speeds=<selected>` and its speeds have no `unknown`, so a literal match would hide
 * every PGN and reference game. Rules: `ultraBullet` counts as bullet; a speed set covering every
 * time class (lila's default omits ultraBullet) or no speeds means no time-class restriction, which
 * keeps `unknown`; `modes=rated,casual` (or none) means no rated restriction; months are UTC and
 * inclusive.
 */
export interface ExplorerQuery {
  variant?: 'standard';
  fen?: Fen;
  /** UCI csv from `fen`. */
  play?: string;
  /** Lila's speeds csv: ultraBullet,bullet,blitz,rapid,classical,correspondence (see above). */
  speeds?: string;
  /** Lila's modes csv: `rated`, `casual` (see above). */
  modes?: string;
  /** `YYYY-MM` (lichess, player) or `YYYY` (masters), inclusive. */
  since?: string;
  until?: string;
  moves?: number;
  topGames?: number;
  recentGames?: number;
  ratings?: string;
}

/** `GET /api/explorer/player` query. Outpost filters travel in the `/f/<filters>/` path segment. */
export interface ExplorerPlayerQuery extends ExplorerQuery {
  player: ExplorerPlayerSpec;
  color: Color;
}

/**
 * `GET /api/explorer/games` query: games that reach a position (`fen` or `play` from the start).
 * Takes the filters as a normal query, plus lila's `speeds`/`modes`/`since`/`until` with the same
 * meaning as in the player explorer (`explorerQueryRestrictions`), so the list matches its counts.
 */
export type ExplorerGamesQuery = ProfileFilters &
  PageQuery &
  Pick<ExplorerQuery, 'speeds' | 'modes' | 'since' | 'until'> & {
    player: ExplorerPlayerSpec;
    fen?: Fen;
    play?: string;
  };

/**
 * `GET /api/explorer/games`. Profile / account specs give player-perspective rows;
 * `db:` and `ref:` specs give neutral rows.
 */
export type ExplorerGamesPage = Paged &
  ({ perspective: 'player'; games: GameRow[] } | { perspective: 'neutral'; games: DbGameRow[] });

/**
 * `GET /api/tablebase/:variant` response: tablebase.lichess.ovh's JSON, passed through unchanged
 * (lila parses it). Unauthenticated (lila sends no cookie); query keys as lila sends them.
 */
export type TablebaseResponse = Record<string, unknown>;

/** `GET /api/cloud-eval` query (proxied to lichess.org/api/cloud-eval). */
export interface CloudEvalQuery {
  fen: Fen;
  multiPv?: number;
  variant?: 'standard';
  /**
   * `'1'`: a position without a cloud eval answers 200 with `pvs: []` (`depth`/`knodes` 0, `fen`
   * the requested position) instead of 404, so the browser logs no failed request for an ordinary
   * miss (the Studio asks for every position it shows; decision 12). Without it a miss is 404.
   */
  emptyOnMiss?: '1';
}

/**
 * `GET /api/cloud-eval` response (Lichess shape). A miss is 404 `not_found`, or 200 with `pvs: []`
 * when the request sets `emptyOnMiss=1`.
 */
export interface CloudEvalResponse {
  fen: Fen;
  knodes: number;
  depth: number;
  pvs: Array<{ moves: string; cp?: number; mate?: number }>;
}

// ===========================================================================
// Databases (PLAN §4 databases, §6)
// ===========================================================================

/** `games` = a user's PGN collection; `reference` = an OTB/broadcast reference DB (admin-managed). */
export type DatabaseKind = 'games' | 'reference';

/** `GET /api/databases`, `GET /api/databases/:id`. */
export interface DatabaseInfo {
  id: Id;
  name: string;
  kind: DatabaseKind;
  visibility: Visibility;
  owner: { id: Id; username: string } | null;
  /** Where the games came from, e.g. "Lichess broadcasts" or "TWIC". */
  sourceLabel: string | null;
  /** Licence / attribution text shown with the data, e.g. "CC BY-SA 4.0". */
  licence: string | null;
  createdAt: EpochMs;
  gameCount: number;
  canEdit: boolean;
  /** The latest import job, while queued/running or if it failed. */
  importJob: JobInfo | null;
  /**
   * The latest finished PGN import (`done`), whose `progress.counts` hold the summary
   * (`imported`, `duplicates`, `skipped`, and `skip:<reason>` per skip reason). Null when none.
   */
  lastImport?: JobInfo | null;
}

/** `GET /api/databases`. Mine plus visible public ones. */
export interface DatabasesResponse {
  databases: DatabaseInfo[];
}

/** `POST /api/databases`. Returns `DatabaseInfo` (kind `games`). */
export interface CreateDatabaseRequest {
  name: string;
  visibility?: Visibility;
  sourceLabel?: string;
  licence?: string;
}

/** `PATCH /api/databases/:id`. Returns `DatabaseInfo`. */
export interface UpdateDatabaseRequest {
  name?: string;
  visibility?: Visibility;
  sourceLabel?: string | null;
  licence?: string | null;
}

/** `POST /api/databases/:id/import` JSON form (or multipart field `file` with a `.pgn`). */
export interface ImportPgnRequest {
  pgn: string;
}

/** Response of import endpoints: the queued job. Duplicates are counted in `progress.counts`. */
export interface ImportResponse {
  job: JobInfo;
}

/** `GET /api/databases/:id/games` query (pageSize defaults to 50). */
export interface DbGamesQuery extends PageQuery {
  /** Player name or event substring. */
  q?: string;
}

/** `GET /api/databases/:id/games`. */
export interface DbGamesPage extends Paged {
  games: DbGameRow[];
}

// ===========================================================================
// Studio files (PLAN §4 files, §8.4)
// ===========================================================================

/** File kind in "My Files". */
export type FileKind = 'study' | 'repertoire';

/** File metadata (lists don't include the PGN). */
export interface StudioFileMeta {
  id: Id;
  /** Slash-separated folder path, `''` for the root. */
  folder: string;
  name: string;
  kind: FileKind;
  /** Repertoire side, null for studies. */
  color: Color | null;
  createdAt: EpochMs;
  updatedAt: EpochMs;
  /** Set when in the recycle bin. */
  deletedAt: EpochMs | null;
}

/** A full file (`GET /api/files/:id`). */
export interface StudioFile extends StudioFileMeta {
  /** PGN with variations, comments and NAGs (may contain several games). */
  pgn: string;
}

/** `GET /api/files` query: one folder (omit for all), or the recycle bin with `trash=1`. */
export interface FilesQuery {
  folder?: string;
  trash?: '1';
}

/** `GET /api/files`. */
export interface FilesResponse {
  files: StudioFileMeta[];
}

/** `POST /api/files`. Returns `StudioFile`. */
export interface CreateFileRequest {
  folder: string;
  name: string;
  kind: FileKind;
  color?: Color | null;
  pgn: string;
}

/**
 * `PUT /api/files/:id`. Returns `StudioFile`. When `baseUpdatedAt` is given and the stored
 * file is newer, the server answers 409 `conflict` (another tab or device saved first).
 */
export interface UpdateFileRequest {
  folder?: string;
  name?: string;
  kind?: FileKind;
  color?: Color | null;
  pgn?: string;
  baseUpdatedAt?: EpochMs;
}

/** `GET /api/files/search?fen=`: files containing a position. */
export interface FileSearchHit {
  file: StudioFileMeta;
  /** Where the position occurs: game index in the file and ply, plus the move played next if any. */
  matches: Array<{ gameIndex: number; ply: number; nextSan: string | null }>;
}

/** `GET /api/files/search`. */
export interface FileSearchResponse {
  fen: Fen;
  hits: FileSearchHit[];
}

/** One folder in `GET /api/folders`. */
export interface FolderInfo {
  /** Slash-separated path, `''` for the root. */
  path: string;
  fileCount: number;
}

/** `GET /api/folders`. */
export interface FoldersResponse {
  folders: FolderInfo[];
  trashCount: number;
}

// ===========================================================================
// Reference database (PLAN §5 Ultra/Masters, §6)
// ===========================================================================

/** A broadcast month known to the reference DB. */
export interface BroadcastMonthStatus {
  month: IsoMonth;
  status: 'available' | 'queued' | 'importing' | 'imported' | 'error';
  games: number;
  importedAt: EpochMs | null;
  /** Why the last import failed (status `error`). */
  error?: string | null;
}

/** `GET /api/reference`. */
export interface ReferenceInfo {
  databases: DatabaseInfo[];
  totalGames: number;
  /** Database.lichess.org broadcast months and their import state (admin UI). */
  broadcastMonths: BroadcastMonthStatus[];
  /** Attribution lines to show wherever reference data appears. */
  attribution: string[];
}

/** A player in the reference DB (FIDE id when known). */
export interface ReferencePlayer {
  fideId: string | null;
  name: string;
  title: Title | null;
  /** FIDE federation code as written in the source (e.g. `NOR`). */
  federation: string | null;
  games: number;
  lastPlayed: EpochMs | null;
  maxRating: number | null;
  /** Rating in the player's most recent game, when known. */
  lastRating?: number | null;
  /**
   * Players without a FIDE id are indexed per reference database: its id (attach them as a `pgn`
   * source with this `databaseId` and `key` = `name`). Null for FIDE players (every reference DB).
   */
  databaseId?: Id | null;
  /** A visible local profile with this FIDE source (or pgn source, without a FIDE id), if any. */
  profileSlug: string | null;
}

/** `GET /api/reference/players?q=`. */
export interface ReferencePlayersResponse {
  players: ReferencePlayer[];
}

/** `POST /api/admin/reference/broadcast-months`. Returns `ImportJobsResponse`. */
export interface BroadcastMonthsRequest {
  months: IsoMonth[];
  /** Target reference DB; defaults to the built-in "Lichess broadcasts" database. */
  databaseId?: Id;
}

/** `POST /api/admin/reference/import` JSON form (or multipart `file`, with these as fields). */
export interface ReferenceImportRequest {
  url?: string;
  /** Existing reference DB, or create one named `databaseName`. */
  databaseId?: Id;
  databaseName?: string;
  sourceLabel?: string;
  licence?: string;
}

/** Response when several jobs are queued at once. */
export interface ImportJobsResponse {
  jobs: JobInfo[];
}

// ===========================================================================
// Live broadcasts (PLAN §5, §6; proxied from Lichess with the token)
// ===========================================================================

/** A round of a broadcast. */
export interface BroadcastRoundRef {
  id: string;
  name: string;
  slug: string;
  startsAt: EpochMs | null;
  finished: boolean;
  ongoing: boolean;
  url: string;
}

/**
 * A broadcast tournament in lists. In `GET /api/broadcasts`, `rounds` holds only the latest round
 * with games and the current/next (or last) round, as Lichess's list gives them;
 * `GET /api/broadcasts/tour/:tourId` has every round.
 */
export interface BroadcastSummary {
  tour: {
    id: string;
    name: string;
    slug: string;
    tier: number | null;
    /** Start (and end) dates. */
    dates: EpochMs[];
    url: string;
    description: string | null;
    info: { format?: string; tc?: string; fideTC?: string; location?: string; players?: string; website?: string };
  };
  rounds: BroadcastRoundRef[];
  defaultRoundId: string | null;
  /** Has an ongoing round. */
  live: boolean;
}

/** `GET /api/broadcasts`. */
export interface BroadcastsResponse {
  /** Ongoing tours (between rounds too), live ones first. */
  active: BroadcastSummary[];
  /** Finished tours, most recent first. */
  recent: BroadcastSummary[];
  /** Tours that have not started yet (optional for compatibility). */
  upcoming?: BroadcastSummary[];
}

/** `GET /api/broadcasts/tour/:tourId`. */
export type BroadcastTour = BroadcastSummary;

/** A player in a live game preview. */
export interface BroadcastPlayer {
  name: string;
  title: Title | null;
  rating: number | null;
  fideId: string | null;
  /** FIDE federation, e.g. `NOR`. */
  fed: string | null;
  /** Remaining clock in seconds, when known. */
  clock: number | null;
}

/** A mini-board on the round page. */
export interface BroadcastGamePreview {
  id: string;
  name: string;
  white: BroadcastPlayer;
  black: BroadcastPlayer;
  fen: Fen;
  /** Last move in UCI, standard castling. */
  lastMove: string | null;
  /** `*` while running. */
  status: GameResult | '*';
  /** Seconds the side to move has been thinking, when known. */
  thinkTime: number | null;
}

/** `GET /api/broadcasts/round/:roundId` (clients poll every 10 s; server caches 5 s). */
export interface BroadcastRound {
  tour: { id: string; name: string; slug: string };
  round: BroadcastRoundRef;
  games: BroadcastGamePreview[];
  fetchedAt: EpochMs;
}

// ===========================================================================
// Prep (PLAN §5 Tournament preparation)
// ===========================================================================

/** A prep set: a named list of opponent profiles. */
export interface PrepSet {
  id: Id;
  name: string;
  createdAt: EpochMs;
  updatedAt: EpochMs;
  opponents: ProfileSummary[];
}

/** `GET /api/prep`. */
export interface PrepListResponse {
  sets: PrepSet[];
}

/** `POST /api/prep`. Returns `PrepSet`. */
export interface CreatePrepRequest {
  name: string;
  profileIds: Id[];
}

/** `PUT /api/prep/:id`. Returns `PrepSet`. `profileIds` replaces the list. */
export interface UpdatePrepRequest {
  name?: string;
  profileIds?: Id[];
}

/** A repertoire line in a prep report. */
export interface PrepLine extends Wdl {
  line: UciLine;
  /** SAN with move numbers, e.g. `1. e4 c5 2. Nf3`. */
  san: string;
  eco: string | null;
  name: string | null;
  games: number;
  score: number | null;
  lastPlayed: EpochMs | null;
}

/** One side of an opponent's repertoire. */
export interface PrepSide {
  games: number;
  wdl: Wdl;
  topLines: PrepLine[];
  worstLines: PrepLine[];
}

/** Report card for one opponent. */
export interface PrepOpponentReport {
  profile: ProfileSummary;
  asWhite: PrepSide;
  asBlack: PrepSide;
  recentGames: GameRow[];
  /** When they play: by hour and weekday in the requested zone. */
  activity: Pick<ActivityStats, 'tz' | 'byHour' | 'byWeekday'>;
  ratings: Array<{ sourceId: Id; kind: SourceKind; ratings: CurrentRating[] }>;
  /**
   * When the opponent has more selected games than the report samples: the number of most recent
   * games the lines and the activity were computed from (games and W/D/L always count all). Null
   * or absent: all games.
   */
  sampledGames?: number | null;
}

/** Endpoint params of `GET /api/prep/:id/report`: IANA zone for the activity buckets (default UTC). */
export interface PrepReportParams {
  tz?: string;
  /** Length of the repertoire lines in plies (2–20, default 8). */
  plies?: number;
  /** Fewest games for a line to appear among the worst lines (1–100, default 3). */
  minGames?: number;
}

/** `GET /api/prep/:id/report` query: the filters apply to every opponent. */
export type PrepReportQuery = ProfileFilters & PrepReportParams;

/** `GET /api/prep/:id/report`. */
export interface PrepReport {
  prep: { id: Id; name: string };
  generatedAt: EpochMs;
  opponents: PrepOpponentReport[];
}

// ===========================================================================
// Small contract helpers
// ===========================================================================

/** Valid profile slug: lowercase letters, digits and dashes, 2–64 chars, not starting with a dash. */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

const SLUG_TRANSLIT: Record<string, string> = {
  '\u00f8': 'o',
  '\u00e6': 'ae',
  '\u0153': 'oe',
  '\u00df': 'ss',
  '\u0111': 'd',
  '\u0142': 'l',
  '\u00fe': 'th',
  '\u00f0': 'd',
};

/** Turns a display name into a slug candidate (callers add a numeric suffix on conflict). */
export const slugify = (name: string): string => {
  const s = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[\u00f8\u00e6\u0153\u00df\u0111\u0142\u00fe\u00f0]/g, c => SLUG_TRANSLIT[c] ?? '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
  return s.length >= 2 ? s : `player-${s || 'x'}`;
};

/** Prefix of Outpost game ids in explorer responses (`op123`), so lila can tell them from Lichess ids. */
export const EXPLORER_GAME_PREFIX = 'op';

/** Outpost game id → explorer game id. */
export const toExplorerGameId = (id: Id): string => `${EXPLORER_GAME_PREFIX}${id}`;

/** Explorer game id → Outpost game id, or null for a Lichess id. */
export const fromExplorerGameId = (s: string): Id | null =>
  /^op[1-9]\d{0,15}$/.test(s) ? Number(s.slice(EXPLORER_GAME_PREFIX.length)) : null;

// ===========================================================================
// Route builders
// ===========================================================================

/**
 * Encodes a path segment. A Fastify placeholder (`:slug`) passes through unchanged, so the
 * server can build its route patterns from the same table: `API_ROUTES.profile(':slug')`.
 */
const seg = (v: string | number): string => {
  const s = String(v);
  return /^:[A-Za-z][A-Za-z0-9]*$/.test(s) ? s : encodeURIComponent(s);
};

/** Paths of every endpoint (PLAN §6). Query strings are added by the caller (see `toSearchParams`). */
export const API_ROUTES = {
  health: '/api/health',

  // Session, account
  session: '/api/session',
  setup: '/api/setup',
  login: '/api/login',
  logout: '/api/logout',
  signup: '/api/signup',
  me: {
    prefs: '/api/me/prefs',
    password: '/api/me/password',
    totpSetup: '/api/me/totp/setup',
    totpEnable: '/api/me/totp/enable',
    totpDisable: '/api/me/totp/disable',
    sessions: '/api/me/sessions',
    session: (id: string) => `/api/me/sessions/${seg(id)}`,
  },

  // Admin
  admin: {
    settings: '/api/admin/settings',
    users: '/api/admin/users',
    user: (id: Id | string) => `/api/admin/users/${seg(id)}`,
    invites: '/api/admin/invites',
    invite: (code: string) => `/api/admin/invites/${seg(code)}`,
    jobs: '/api/admin/jobs',
    jobRetry: (id: Id | string) => `/api/admin/jobs/${seg(id)}/retry`,
    jobCancel: (id: Id | string) => `/api/admin/jobs/${seg(id)}/cancel`,
    status: '/api/admin/status',
    referenceBroadcastMonths: '/api/admin/reference/broadcast-months',
    referenceImport: '/api/admin/reference/import',
  },
  jobsMine: '/api/jobs/mine',

  // Search and profiles
  search: '/api/search',
  profiles: '/api/profiles',
  profile: (slug: string) => `/api/profiles/${seg(slug)}`,
  profileSources: (slug: string) => `/api/profiles/${seg(slug)}/sources`,
  profileSource: (slug: string, sourceId: Id | string) => `/api/profiles/${seg(slug)}/sources/${seg(sourceId)}`,
  profileUpdate: (slug: string) => `/api/profiles/${seg(slug)}/update`,
  profileStatus: (slug: string) => `/api/profiles/${seg(slug)}/status`,
  profileBookmark: (slug: string) => `/api/profiles/${seg(slug)}/bookmark`,
  bookmarks: '/api/bookmarks',

  // Stats (all take ProfileFilters)
  stats: {
    overview: (slug: string) => `/api/profiles/${seg(slug)}/overview`,
    games: (slug: string) => `/api/profiles/${seg(slug)}/games`,
    gamesPgn: (slug: string) => `/api/profiles/${seg(slug)}/games.pgn`,
    openings: (slug: string) => `/api/profiles/${seg(slug)}/openings`,
    opponents: (slug: string) => `/api/profiles/${seg(slug)}/opponents`,
    behaviour: (slug: string) => `/api/profiles/${seg(slug)}/behaviour`,
    worldmap: (slug: string) => `/api/profiles/${seg(slug)}/worldmap`,
    activity: (slug: string) => `/api/profiles/${seg(slug)}/activity`,
    rating: (slug: string) => `/api/profiles/${seg(slug)}/rating`,
    /** Event-name suggestions (`EventsQuery` → `EventsResponse`); the only stats route without filters. */
    events: (slug: string) => `/api/profiles/${seg(slug)}/events`,
  },

  // Games, explorer and proxies
  game: (id: Id | string) => `/api/games/${seg(id)}`,
  explorer: {
    /**
     * Path of the explorer base. Relative: lila needs the absolute URL from `explorerEndpoint`
     * as `explorer.endpoint` (it resolves `new URL('./masters' | './lichess' | './player', endpoint)`).
     */
    base: '/api/explorer/',
    /** Base path with Outpost filters: `/api/explorer/f/<encoded>/` (see `encodeFiltersSegment`, `explorerEndpoint`). */
    filteredBase: (encodedFilters: string) => `/api/explorer/f/${seg(encodedFilters)}/`,
    masters: '/api/explorer/masters',
    mastersPgn: (id: string) => `/api/explorer/masters/pgn/${seg(id)}`,
    lichess: '/api/explorer/lichess',
    player: '/api/explorer/player',
    playerFiltered: (encodedFilters: string) => `/api/explorer/f/${seg(encodedFilters)}/player`,
    reference: '/api/explorer/reference',
    games: '/api/explorer/games',
  },
  tablebase: (variant: string) => `/api/tablebase/${seg(variant)}`,
  cloudEval: '/api/cloud-eval',
  /** Not under /api: lila's ceval loads `/assets/lifat/nnue/<name>`. */
  nnue: (name: string) => `/assets/lifat/nnue/${seg(name)}`,

  // Databases
  databases: '/api/databases',
  database: (id: Id | string) => `/api/databases/${seg(id)}`,
  databaseImport: (id: Id | string) => `/api/databases/${seg(id)}/import`,
  databaseGames: (id: Id | string) => `/api/databases/${seg(id)}/games`,
  databaseExport: (id: Id | string) => `/api/databases/${seg(id)}/export.pgn`,
  databaseGame: (id: Id | string, gameId: Id | string) => `/api/databases/${seg(id)}/games/${seg(gameId)}`,

  // Studio files
  files: '/api/files',
  file: (id: Id | string) => `/api/files/${seg(id)}`,
  fileRestore: (id: Id | string) => `/api/files/${seg(id)}/restore`,
  filesSearch: '/api/files/search',
  folders: '/api/folders',

  // Reference
  reference: '/api/reference',
  referencePlayers: '/api/reference/players',

  // Broadcasts
  broadcasts: '/api/broadcasts',
  broadcastTour: (tourId: string) => `/api/broadcasts/tour/${seg(tourId)}`,
  broadcastRound: (roundId: string) => `/api/broadcasts/round/${seg(roundId)}`,
  broadcastRoundPgn: (roundId: string) => `/api/broadcasts/round/${seg(roundId)}.pgn`,
  /** One game (board) of a round as PGN, with clocks and comments; `gameId` is `BroadcastGamePreview.id`. */
  broadcastGamePgn: (roundId: string, gameId: string) => `/api/broadcasts/round/${seg(roundId)}/game/${seg(gameId)}.pgn`,

  // Prep
  prep: '/api/prep',
  prepSet: (id: Id | string) => `/api/prep/${seg(id)}`,
  prepReport: (id: Id | string) => `/api/prep/${seg(id)}/report`,
} as const;

/**
 * Absolute `explorer.endpoint` for lila (PLAN §8.3): `${origin}/api/explorer/`, or with Outpost
 * filters `${origin}/api/explorer/f/<segment>/` (`encodeFiltersSegment`). Lila resolves
 * `new URL('./<db>', endpoint)`, which throws on a relative base and would drop a query string.
 */
export const explorerEndpoint = (origin: string, filtersSegment?: string): string =>
  new URL(
    filtersSegment === undefined ? API_ROUTES.explorer.base : API_ROUTES.explorer.filteredBase(filtersSegment),
    origin,
  ).href;

/**
 * Response of every state-changing endpoint (documentation; the server must match it).
 * `OkResponse` is `{ok:true}` with status 200. Non-JSON GETs: `games.pgn`, `export.pgn`,
 * `masters/pgn/:id`, `round/:roundId.pgn` and `round/:roundId/game/:gameId.pgn` stream
 * `application/x-chess-pgn`; the player explorer answers NDJSON (`ExplorerPlayerResponse`, one line).
 */
export const MUTATION_RESPONSES = {
  'POST /api/setup': 'LoginResponse',
  'POST /api/login': 'LoginResponse',
  'POST /api/logout': 'OkResponse',
  'POST /api/signup': 'LoginResponse',
  'PUT /api/me/prefs': 'UserPrefs',
  'POST /api/me/password': 'OkResponse',
  'POST /api/me/totp/setup': 'TotpSetupResponse',
  'POST /api/me/totp/enable': 'OkResponse',
  'POST /api/me/totp/disable': 'OkResponse',
  'DELETE /api/me/sessions/:id': 'OkResponse',
  'PUT /api/admin/settings': 'AdminSettings',
  'PATCH /api/admin/users/:id': 'AdminUser',
  'DELETE /api/admin/users/:id': 'OkResponse',
  'POST /api/admin/invites': 'Invite',
  'DELETE /api/admin/invites/:code': 'OkResponse',
  'POST /api/admin/jobs/:id/retry': 'JobInfo',
  'POST /api/admin/jobs/:id/cancel': 'JobInfo',
  'POST /api/admin/reference/broadcast-months': 'ImportJobsResponse',
  'POST /api/admin/reference/import': 'ImportResponse',
  'POST /api/profiles': 'ProfileHeader',
  'PATCH /api/profiles/:slug': 'ProfileHeader',
  'DELETE /api/profiles/:slug': 'OkResponse',
  'POST /api/profiles/:slug/sources': 'ProfileHeader',
  'DELETE /api/profiles/:slug/sources/:sourceId': 'ProfileHeader',
  'POST /api/profiles/:slug/update': 'ProfileUpdateResponse',
  'PUT /api/profiles/:slug/bookmark': 'BookmarkResponse',
  'DELETE /api/profiles/:slug/bookmark': 'BookmarkResponse',
  'POST /api/databases': 'DatabaseInfo',
  'PATCH /api/databases/:id': 'DatabaseInfo',
  'DELETE /api/databases/:id': 'OkResponse',
  'POST /api/databases/:id/import': 'ImportResponse',
  'DELETE /api/databases/:id/games/:gameId': 'OkResponse',
  'POST /api/files': 'StudioFile',
  'PUT /api/files/:id': 'StudioFile',
  /** Moves the file to the recycle bin; on a file already in the bin, deletes it for good. */
  'DELETE /api/files/:id': 'OkResponse',
  'POST /api/files/:id/restore': 'StudioFile',
  'POST /api/prep': 'PrepSet',
  'PUT /api/prep/:id': 'PrepSet',
  'DELETE /api/prep/:id': 'OkResponse',
} as const;

/** Custom header every non-GET request must carry (CSRF defence, PLAN §6). */
export const CSRF_HEADER = 'x-outpost';
/** Value of `CSRF_HEADER`. */
export const CSRF_HEADER_VALUE = '1';
/** Session cookie name (PLAN §6). */
export const SESSION_COOKIE = 'outpost_session';
