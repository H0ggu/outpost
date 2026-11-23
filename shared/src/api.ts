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

/** `POST /api/me/totp/setup`: a pending secret; nothing changes until it is confirmed with `enable`. */
export interface TotpSetupResponse {
  /** Base32 secret for manual entry. */
  secret: string;
  /** `otpauth://totp/...` URI. */
  otpauthUrl: string;
  /** The URI as an inline SVG QR code (rendered server-side, no external requests). */
  qrSvg: string;
}

/** `POST /api/me/totp/enable`: confirm the pending secret with a current code. */
export interface TotpEnableRequest {
  code: string;
}

/** `POST /api/me/totp/disable`. */
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

/** `GET /api/admin/settings`. */
export interface AdminSettings {
  signupMode: SignupMode;
  anonymousBrowsing: boolean;
  lichessToken: MaskedSecret;
  chesscomContact: string;
  /** True when `CHESSCOM_CONTACT` is set in env (env wins). */
  chesscomContactFromEnv: boolean;
  /** Hour (0–23, UTC) of the daily auto refresh. */
  autoRefreshHourUtc: number;
  /** Minimum minutes between manual updates of one profile. */
  updateCooldownMinutes: number;
  /** Months of history for a source's first import; 0 = everything. */
  initialSyncMonths: number;
  mastersSource: MastersSource;
}

/** `PUT /api/admin/settings` body: any subset. `lichessToken: null` clears the UI-set token. */
export interface UpdateAdminSettingsRequest {
  signupMode?: SignupMode;
  anonymousBrowsing?: boolean;
  lichessToken?: string | null;
  chesscomContact?: string;
  autoRefreshHourUtc?: number;
  updateCooldownMinutes?: number;
  initialSyncMonths?: number;
  mastersSource?: MastersSource;
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

/** `PATCH /api/admin/users/:id`. `password` resets it and signs the user out everywhere. */
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

/** One upstream reachability probe in `AdminStatus`. */
export interface UpstreamStatus {
  name: 'lichess' | 'lichess-explorer' | 'chesscom' | 'lichess-database' | 'stockfish-nnue';
  url: string;
  ok: boolean;
  status: number | null;
  latencyMs: number | null;
  error: string | null;
}

/** `GET /api/admin/status`. */
export interface AdminStatus {
  version: string;
  nodeVersion: string;
  sqliteVersion: string;
  uptimeSec: number;
  dataDir: string;
  dbSizeBytes: number;
  lichessToken: {
    configured: boolean;
    /** null when not checked or not configured. */
    valid: boolean | null;
    userId: string | null;
    scopes: string[];
  };
  upstream: UpstreamStatus[];
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
  /** Lowercase username, FIDE id, or `dbId:playerName`. */
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

/** A source to attach to a profile (create / add). */
export interface NewSourceInput {
  kind: SourceKind;
  /** Username (lichess/chesscom), FIDE id (fide), or player name (pgn, together with `databaseId`). */
  key: string;
  /** For `pgn`: the player's name as written in the PGN. Defaults to `key`. */
  playerName?: string;
  /** For `pgn`: which database. */
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

/** `GET /api/profiles/:slug/games` query (pageSize defaults to 20). */
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

/** `GET /api/profiles/:slug/openings` query. Move bounds are full moves (1–5 in the UI). */
export interface OpeningsQuery {
  side?: 'white' | 'black' | 'both';
  order?: 'most' | 'best' | 'worst';
  minGames?: number;
  minMoves?: number;
  maxMoves?: number;
}

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

/** `GET /api/profiles/:slug/opponents` query (pageSize defaults to 20). */
export interface OpponentsQuery extends PageQuery {
  view?: 'most' | 'titled';
}

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

/** `GET /api/profiles/:slug/worldmap`. */
export interface WorldMapStats {
  countries: WorldMapCountry[];
  /** Games whose opponent country is unknown (not looked up yet, or no flag). */
  unknownGames: number;
  /** Opponents still queued for a country lookup. */
  pendingLookups: number;
}

/** `GET /api/profiles/:slug/activity` query: IANA zone for bucketing (default UTC). */
export interface ActivityQuery {
  tz?: string;
}

/** `GET /api/profiles/:slug/activity`. */
export interface ActivityStats {
  tz: string;
  /** Every day from the first to the last game in range, oldest first. */
  days: ActivityDay[];
  /** 24 entries, local hour 0–23. */
  byHour: ActivityCell[];
  /** 7 entries, Monday = 0 … Sunday = 6. */
  byWeekday: ActivityCell[];
  /** `grid[weekday][hour]`, same indexing as above. */
  grid: ActivityCell[][];
}

/** `GET /api/profiles/:slug/rating` query: restrict to one source and/or time class. */
export interface RatingQuery {
  source?: Id;
  tc?: TimeClass;
}

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

/** Query of the explorer endpoints, as lila sends it (PLAN §6). */
export interface ExplorerQuery {
  variant?: 'standard';
  fen?: Fen;
  /** UCI csv from `fen`. */
  play?: string;
  /** Lila's speeds csv: ultraBullet,bullet,blitz,rapid,classical,correspondence. */
  speeds?: string;
  /** `rated,casual`. */
  modes?: string;
  /** `YYYY-MM` or `YYYY`. */
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

/** `GET /api/explorer/games` query: games that reach a position (`fen` or `play` from the start). */
export type ExplorerGamesQuery = ProfileFilters &
  PageQuery & {
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

/** `GET /api/cloud-eval` query (proxied to lichess.org/api/cloud-eval). */
export interface CloudEvalQuery {
  fen: Fen;
  multiPv?: number;
  variant?: 'standard';
}

/** `GET /api/cloud-eval` response (Lichess shape). 404 when no cloud eval exists. */
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
  /** A visible local profile with this FIDE source, if any. */
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

/** A broadcast tournament in lists. */
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
  active: BroadcastSummary[];
  recent: BroadcastSummary[];
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
}

/** `GET /api/prep/:id/report` (takes ProfileFilters plus `tz`). */
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
  },

  // Games, explorer and proxies
  game: (id: Id | string) => `/api/games/${seg(id)}`,
  explorer: {
    /** Base handed to lila as `explorer.endpoint` (it appends `masters`, `lichess`, `player`). */
    base: '/api/explorer/',
    /** Base with Outpost filters in the path: `/api/explorer/f/<encoded>/` (see `encodeFiltersSegment`). */
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

  // Prep
  prep: '/api/prep',
  prepSet: (id: Id | string) => `/api/prep/${seg(id)}`,
  prepReport: (id: Id | string) => `/api/prep/${seg(id)}/report`,
} as const;

/** Custom header every non-GET request must carry (CSRF defence, PLAN §6). */
export const CSRF_HEADER = 'x-outpost';
/** Value of `CSRF_HEADER`. */
export const CSRF_HEADER_VALUE = '1';
/** Session cookie name (PLAN §6). */
export const SESSION_COOKIE = 'outpost_session';
