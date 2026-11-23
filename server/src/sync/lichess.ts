/**
 * Lichess importer (PLAN §7 "Lichess"; docs/research/lichess-api.md §1–2).
 *
 * 1. `GET /api/user/{u}` → the `sources` row (display name, user id, title, country from
 *    `profile.flag`) and `profile_json` (current ratings per perf, FIDE rating). Unknown (404) and
 *    closed (`disabled`) accounts fail the sync with `last_sync_error`; `tosViolation` imports but
 *    keeps a warning in `last_sync_error`.
 * 2. Games that were still ongoing at the last sync are re-fetched by id
 *    (`POST /api/games/export/_ids`): the `since` cursor is on `createdAt`, so a correspondence
 *    game created before the cursor would otherwise never be imported once finished.
 * 3. `GET /api/games/user/{u}` as NDJSON (`since` = last `createdAt` + 1, `sort=dateAsc`, opening,
 *    accuracy, standard perf types, ongoing games listed so they can be tracked). Games are stored
 *    in short batches; the cursor is saved in the same transaction, so an interrupted sync resumes
 *    after the last stored batch. The first import starts `initialSyncMonths` back (0 = all); a
 *    `full` resync forgets the cursor and re-reads the whole history (resuming, not restarting,
 *    when that same job is interrupted).
 *
 * Mapping (`mapLichessGame`): variants, from-position games, games against the AI and anonymous
 * players are skipped; UltraBullet counts as bullet; ratings are pre-game and
 * `ratingAfter = rating + ratingDiff`; a `draw` status is split into dead position / threefold /
 * 50-move / agreement from the final position. No Lichess endpoint used here needs a token (it
 * only raises the export rate when one is configured).
 */
import type { EpochMs, TimeClass } from '@outpost/shared/api';
import {
  lichessResult,
  lichessSpeedToTimeClass,
  lichessStatusToTermination,
  type Color,
  type Termination,
} from '@outpost/shared/chess';
import { drawKindOf, isReplayError, replaySan } from '../chess/replay.ts';
import type { NormalizedGame, NormalizedPlayer } from '../chess/store.ts';
import { UPSTREAM } from '../http/upstream.ts';
import type { JobContext } from '../jobs/handlers.ts';
import { readSettings } from '../settings.ts';
import {
  countryFromLichessFlag,
  finishSync,
  GameImporter,
  initialCutoff,
  readJsonBody,
  readNdjson,
  savedSyncState,
  saveSyncState,
  SyncError,
  titleOrNull,
  type FullResyncMarker,
  type SourceRow,
} from './common.ts';
import { ratingValue, storeSourceProfile, type SourceProfileRating, type SourceProfileSnapshot } from './profile.ts';

export const LICHESS_HOST = 'lichess.org';
/** Standard-chess perf types requested from the game export. */
export const LICHESS_PERF_TYPES = 'ultraBullet,bullet,blitz,rapid,classical,correspondence';
/** Lichess usernames: 2–30 letters, digits, `_` and `-`, starting with a letter or digit. */
export const LICHESS_USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,29}$/;
/** Earliest `since` the export accepts. */
export const LICHESS_MIN_SINCE = 1356998400070;
/** Ongoing games remembered for the next sync (and the `_ids` export limit). */
export const MAX_PENDING_IDS = 300;
/** Games per database transaction. */
export const LICHESS_BATCH = 100;

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** A perf in `GET /api/user/{u}`. */
export interface LichessPerf {
  games?: number;
  rating?: number;
  rd?: number;
  prog?: number;
  prov?: boolean;
}

/** `GET /api/user/{u}` / `POST /api/users` item (the fields Outpost reads). */
export interface LichessUser {
  id: string;
  username: string;
  title?: string;
  disabled?: boolean;
  tosViolation?: boolean;
  createdAt?: number;
  seenAt?: number;
  url?: string;
  perfs?: Record<string, LichessPerf | undefined>;
  profile?: { flag?: string; country?: string; fideRating?: number };
  count?: { all?: number; rated?: number };
}

/** One side of an exported game. */
export interface LichessGamePlayer {
  user?: { id: string; name: string; title?: string };
  rating?: number;
  ratingDiff?: number;
  provisional?: boolean;
  aiLevel?: number;
  analysis?: { accuracy?: number };
}

/** An exported game (NDJSON line of `/api/games/user/{u}`). */
export interface LichessGame {
  id: string;
  rated?: boolean;
  variant?: string;
  speed?: string;
  perf?: string;
  createdAt?: number;
  lastMoveAt?: number;
  status: string;
  players: { white: LichessGamePlayer; black: LichessGamePlayer };
  winner?: Color;
  opening?: { eco: string; name: string; ply: number };
  moves?: string;
  initialFen?: string;
  daysPerTurn?: number;
  clock?: { initial: number; increment: number; totalTime?: number };
  tournament?: string;
  swiss?: string;
  arenaTour?: { id: string; name?: string };
  swissTour?: { id: string; name?: string };
}

/** Why a Lichess game is not stored. */
export type LichessSkipReason = 'variant' | 'fromPosition' | 'ai' | 'anonymous' | 'ongoing' | 'noResult' | 'noMoves' | 'illegalMove';

const ONGOING_STATUSES = new Set(['created', 'started']);

const PERF_CLASSES: ReadonlyArray<readonly [string, Exclude<TimeClass, 'unknown'>]> = [
  ['bullet', 'bullet'],
  ['blitz', 'blitz'],
  ['rapid', 'rapid'],
  ['classical', 'classical'],
  ['correspondence', 'correspondence'],
];

/** `GET /api/user/{u}` → `profile_json` snapshot. */
export function lichessSnapshot(user: LichessUser, now: EpochMs): SourceProfileSnapshot {
  const ratings: SourceProfileRating[] = [];
  for (const [perf, timeClass] of PERF_CLASSES) {
    const p = user.perfs?.[perf];
    const rating = ratingValue(p?.rating);
    if (!p || rating === null || !(p.games && p.games > 0)) continue;
    ratings.push({ timeClass, rating, rd: ratingValue(p.rd), provisional: p.prov === true, games: p.games, best: null });
  }
  const extraRatings: SourceProfileSnapshot['extraRatings'] = {};
  const ub = user.perfs?.ultraBullet;
  const ubRating = ratingValue(ub?.rating);
  if (ub && ubRating !== null && ub.games && ub.games > 0) {
    extraRatings.ultraBullet = { rating: ubRating, rd: ratingValue(ub.rd), provisional: ub.prov === true, games: ub.games };
  }
  const flag = user.profile?.flag ?? user.profile?.country ?? null;
  const fide = ratingValue(user.profile?.fideRating);
  return {
    v: 1,
    site: 'lichess',
    fetchedAt: now,
    username: user.username,
    userId: user.id,
    url: user.url ?? `${UPSTREAM.lichess}/@/${user.username}`,
    title: titleOrNull(user.title),
    country: countryFromLichessFlag(flag),
    countryRaw: typeof flag === 'string' ? flag : null,
    createdAt: typeof user.createdAt === 'number' ? user.createdAt : null,
    seenAt: typeof user.seenAt === 'number' ? user.seenAt : null,
    closed: user.disabled === true,
    violation: user.tosViolation === true,
    ratings,
    extraRatings,
    fide: fide !== null ? { standard: fide, rapid: null, blitz: null } : null,
    counts: user.count ? { all: user.count.all ?? null, rated: user.count.rated ?? null } : null,
  };
}

const pad = (n: number): string => String(n).padStart(2, '0');
const pgnDate = (t: number): string => {
  const d = new Date(t);
  return `${d.getUTCFullYear()}.${pad(d.getUTCMonth() + 1)}.${pad(d.getUTCDate())}`;
};
const pgnTime = (t: number): string => {
  const d = new Date(t);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
};

/** Lichess's PGN `Termination` tag for a status (lila PgnDump). */
function terminationTag(status: string): string {
  switch (status) {
    case 'aborted':
    case 'noStart':
      return 'Abandoned';
    case 'timeout':
    case 'outoftime':
      return 'Time forfeit';
    case 'cheat':
      return 'Rules infraction';
    case 'created':
    case 'started':
    case 'unknownFinish':
      return 'Unterminated';
    default:
      return 'Normal';
  }
}

const SPEED_NAMES: Readonly<Record<string, string>> = {
  ultraBullet: 'UltraBullet',
  bullet: 'Bullet',
  blitz: 'Blitz',
  rapid: 'Rapid',
  classical: 'Classical',
  correspondence: 'Correspondence',
};

/** Event like Lichess's PGN: the arena's name, or "Rated Blitz game" / "Casual Rapid game". */
function eventName(g: LichessGame): string {
  if (g.arenaTour?.name) return g.arenaTour.name;
  if (g.swissTour?.name) return g.swissTour.name;
  if (g.arenaTour || g.tournament) return `${g.rated ? 'Rated' : 'Casual'} ${SPEED_NAMES[g.speed ?? ''] ?? 'Standard'} arena`;
  if (g.swissTour || g.swiss) return `${g.rated ? 'Rated' : 'Casual'} ${SPEED_NAMES[g.speed ?? ''] ?? 'Standard'} swiss`;
  return `${g.rated ? 'Rated' : 'Casual'} ${SPEED_NAMES[g.speed ?? ''] ?? 'Standard'} game`;
}

/** `180+2` for clocks, `1/<seconds>` per move for correspondence (Chess.com's daily form), else null. */
function timeControlOf(g: LichessGame): string | null {
  if (g.clock && Number.isFinite(g.clock.initial) && Number.isFinite(g.clock.increment)) return `${g.clock.initial}+${g.clock.increment}`;
  if (g.daysPerTurn && g.daysPerTurn > 0) return `1/${g.daysPerTurn * 86_400}`;
  return null;
}

/** Maps an exported Lichess game to a `NormalizedGame`, or says why it is skipped. */
export function mapLichessGame(g: LichessGame): NormalizedGame | { skip: LichessSkipReason; detail?: string } {
  if ((g.variant ?? 'standard') !== 'standard') return { skip: g.variant === 'fromPosition' ? 'fromPosition' : 'variant' };
  if (g.initialFen && g.initialFen !== START_FEN) return { skip: 'fromPosition' };
  const w = g.players?.white;
  const b = g.players?.black;
  if (!w || !b) return { skip: 'anonymous' };
  if (w.aiLevel !== undefined || b.aiLevel !== undefined) return { skip: 'ai' };
  if (!w.user?.name || !b.user?.name) return { skip: 'anonymous' };
  if (ONGOING_STATUSES.has(g.status)) return { skip: 'ongoing' };
  const result = lichessResult(g.status, g.winner);
  if (!result) return { skip: 'noResult' };
  const moves = (g.moves ?? '').split(' ').filter(Boolean);
  if (moves.length === 0) return { skip: 'noMoves' };

  let termination: Termination = lichessStatusToTermination(g.status, g.winner);
  if (g.status === 'draw') {
    const replay = replaySan(moves, { trackRepetition: true });
    if (isReplayError(replay)) return { skip: 'illegalMove', detail: `${replay.illegal} at ply ${replay.ply}` };
    termination = drawKindOf(replay) ?? 'agreement';
  }

  const createdAt = typeof g.createdAt === 'number' ? g.createdAt : null;
  const endedAt = typeof g.lastMoveAt === 'number' ? g.lastMoveAt : createdAt;
  const player = (p: LichessGamePlayer): NormalizedPlayer => {
    const rating = ratingValue(p.rating);
    return {
      name: p.user!.name,
      rating,
      ratingAfter: rating !== null && typeof p.ratingDiff === 'number' ? rating + p.ratingDiff : null,
      title: titleOrNull(p.user!.title),
      fideId: null,
      accuracy: typeof p.analysis?.accuracy === 'number' ? p.analysis.accuracy : null,
    };
  };
  const white = player(w);
  const black = player(b);
  const timeControl = timeControlOf(g);
  const url = `${UPSTREAM.lichess}/${g.id}`;
  const event = eventName(g);

  const headers: Record<string, string> = {
    Event: event,
    Site: url,
    Date: createdAt !== null ? pgnDate(createdAt) : '????.??.??',
    White: white.name,
    Black: black.name,
    Result: result,
    GameId: g.id,
  };
  if (createdAt !== null) {
    headers.UTCDate = pgnDate(createdAt);
    headers.UTCTime = pgnTime(createdAt);
  }
  if (white.rating !== null) headers.WhiteElo = String(white.rating);
  if (black.rating !== null) headers.BlackElo = String(black.rating);
  if (typeof w.ratingDiff === 'number') headers.WhiteRatingDiff = w.ratingDiff > 0 ? `+${w.ratingDiff}` : String(w.ratingDiff);
  if (typeof b.ratingDiff === 'number') headers.BlackRatingDiff = b.ratingDiff > 0 ? `+${b.ratingDiff}` : String(b.ratingDiff);
  if (white.title) headers.WhiteTitle = white.title;
  if (black.title) headers.BlackTitle = black.title;
  headers.Variant = 'Standard';
  headers.TimeControl = g.clock ? `${g.clock.initial}+${g.clock.increment}` : '-';
  if (g.opening?.eco) headers.ECO = g.opening.eco;
  if (g.opening?.name) headers.Opening = g.opening.name;
  headers.Termination = terminationTag(g.status);

  return {
    origin: 'lichess',
    originId: g.id,
    url,
    databaseId: null,
    white,
    black,
    result,
    termination,
    timeClass: lichessSpeedToTimeClass(g.speed),
    timeControl,
    rated: g.rated === true,
    event,
    round: null,
    startedAt: createdAt,
    endedAt,
    moves,
    headers,
  };
}

/** `sources.sync_state_json` of a Lichess source. */
export interface LichessSyncState extends FullResyncMarker {
  v: 1;
  /** Next `since` (epoch ms): last seen `createdAt` + 1. */
  since: EpochMs | null;
  /** Games that were ongoing at the last sync, re-fetched by id next time. */
  pendingIds: string[];
}

/** Options of `syncLichess` (`max` caps the export, for smoke tests). */
export interface LichessSyncOptions {
  max?: number;
}

const gameParams = (): URLSearchParams =>
  new URLSearchParams({ moves: 'true', opening: 'true', accuracy: 'true', clocks: 'false', evals: 'false' });

/** Runs a sync of one Lichess source (see the file header). Returns the stored state. */
export async function syncLichess(ctx: JobContext<'sync'>, src: SourceRow, opts: LichessSyncOptions = {}): Promise<LichessSyncState> {
  const { db, upstream, signal } = ctx;
  if (!LICHESS_USERNAME_RE.test(src.key)) throw new SyncError(`"${src.key}" is not a valid Lichess username`);
  const startedAt = Date.now();
  const importer = new GameImporter(ctx, src.id, LICHESS_BATCH);
  importer.counts.ongoing = 0;
  importer.report(0, null, 'Reading the Lichess profile');

  // 1. Profile.
  const res = await upstream.fetch(`${UPSTREAM.lichess}/api/user/${encodeURIComponent(src.key)}`, {
    auth: 'optional',
    signal,
    allowStatuses: [404],
    headers: { accept: 'application/json' },
  });
  if (res.status === 404) {
    void res.body?.cancel().catch(() => {});
    throw new SyncError(`The Lichess account "${src.display_name}" does not exist`);
  }
  const user = await readJsonBody<LichessUser>(res, LICHESS_HOST, signal);
  if (!user || typeof user.id !== 'string' || typeof user.username !== 'string') {
    throw new SyncError('Lichess sent an unexpected profile');
  }
  const snapshot = lichessSnapshot(user, startedAt);
  storeSourceProfile(db, src, snapshot, startedAt);
  if (snapshot.closed) throw new SyncError(`The Lichess account "${snapshot.username}" is closed`);
  const warning = snapshot.violation ? `Lichess marks "${snapshot.username}" for violating its Terms of Service` : null;

  // 2. Cursor.
  const full = ctx.job.payload.full === true;
  const saved = savedSyncState<LichessSyncState>(ctx, src.sync_state_json);
  const firstSince = full ? null : initialCutoff(startedAt, readSettings(db, ctx.config).initialSyncMonths);
  const state: LichessSyncState = {
    v: 1,
    since: typeof saved?.since === 'number' ? saved.since : firstSince,
    pendingIds: [],
    ...(full ? { fullJob: ctx.job.id } : {}),
  };
  // Games that were still being played last time. They stay in `pending` until Lichess reports
  // them finished (or forgets them), so a sync interrupted while re-checking them loses none.
  const recheck = [
    ...new Set((Array.isArray(saved?.pendingIds) ? saved.pendingIds : []).filter(id => typeof id === 'string' && /^[A-Za-z0-9]{8}$/.test(id))),
  ].slice(-MAX_PENDING_IDS);
  const pending = new Set<string>(recheck);
  const remember = (): LichessSyncState => {
    state.pendingIds = [...pending].slice(-MAX_PENDING_IDS);
    return state;
  };
  let seen = 0;
  const consume = (g: LichessGame): boolean => {
    seen++;
    const mapped = mapLichessGame(g);
    if (!('skip' in mapped)) {
      pending.delete(g.id);
      return importer.add(mapped);
    }
    if (mapped.skip === 'ongoing') {
      pending.add(g.id);
      importer.counts.ongoing!++;
    } else {
      pending.delete(g.id);
      importer.skip();
    }
    return false;
  };
  const report = (): void =>
    importer.report(seen, null, `${importer.counts.imported} new game${importer.counts.imported === 1 ? '' : 's'} imported`);

  // 3. Re-check the games that were in progress.
  if (recheck.length > 0) {
    importer.report(0, null, `Checking ${recheck.length} game${recheck.length === 1 ? '' : 's'} that were in progress`);
    const r = await upstream.fetch(`${UPSTREAM.lichess}/api/games/export/_ids?${gameParams()}`, {
      method: 'POST',
      body: recheck.join(','),
      auth: 'optional',
      signal,
      headers: { accept: 'application/x-ndjson', 'content-type': 'text/plain' },
    });
    const returned = new Set<string>();
    for await (const g of readNdjson<LichessGame>(r, LICHESS_HOST, signal)) {
      if (!g || typeof g.id !== 'string') continue;
      returned.add(g.id);
      if (consume(g)) await importer.flush(() => saveSyncState(db, src.id, remember()));
    }
    // Ids Lichess no longer knows (deleted games) are dropped.
    for (const id of recheck) if (!returned.has(id)) pending.delete(id);
    await importer.flush(() => saveSyncState(db, src.id, remember()));
    report();
  }

  // 4. New games since the cursor, oldest first.
  const params = gameParams();
  params.set('sort', 'dateAsc');
  params.set('perfType', LICHESS_PERF_TYPES);
  params.set('ongoing', 'true');
  params.set('finished', 'true');
  if (state.since !== null) params.set('since', String(Math.max(LICHESS_MIN_SINCE, state.since)));
  if (opts.max !== undefined && opts.max > 0) params.set('max', String(Math.floor(opts.max)));
  const stream = await upstream.fetch(`${UPSTREAM.lichess}/api/games/user/${encodeURIComponent(src.key)}?${params}`, {
    auth: 'optional',
    signal,
    allowStatuses: [404],
    headers: { accept: 'application/x-ndjson' },
  });
  if (stream.status === 404) {
    void stream.body?.cancel().catch(() => {});
    throw new SyncError(`Lichess has no games for "${snapshot.username}"`);
  }
  for await (const g of readNdjson<LichessGame>(stream, LICHESS_HOST, signal)) {
    if (typeof g?.createdAt === 'number') state.since = Math.max(state.since ?? 0, g.createdAt + 1);
    if (g && typeof g.id === 'string' && consume(g)) await importer.flush(() => saveSyncState(db, src.id, remember()));
    report();
  }
  delete state.fullJob;
  await importer.flush(() => finishSync(db, src.id, remember(), warning, Date.now()));
  report();
  return state;
}
