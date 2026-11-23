/**
 * Chess.com importer (PLAN §7 "Chess.com"; docs/research/chesscom-api.md — trust it over the
 * official docs).
 *
 * 1. `/pub/player/{u}` and `/stats` → the `sources` row (display name from the profile URL,
 *    `player_id`, title, country URL → ISO alpha-2) and `profile_json` (ratings per time class,
 *    FIDE). Unknown accounts (404/410) fail with `last_sync_error`; closed accounts keep a warning.
 * 2. `/games/archives` → months, processed in order: on the first sync from `initialSyncMonths`
 *    back (0 = all), afterwards every month not processed yet, plus every month from the one
 *    before the last completed sync started onwards (games finished after that sync, late daily
 *    games) and always the current and previous month. Months already seen are revalidated with
 *    their stored ETag (`If-None-Match` → 304 = unchanged), so re-polling costs one cheap request
 *    each. A month's ETag is saved in the transaction that stores its last batch, so an
 *    interrupted sync resumes at that month. A listed month that answers 404 is left unprocessed
 *    and fetched again next time. A `full` resync forgets the cursor, the ETags and the
 *    first-import window and re-reads the whole history (resuming, not restarting, when that same
 *    job is interrupted).
 * 3. Mapping (`mapChesscomGame`): only `rules == "chess"` from the standard position; `time_class`
 *    as given (`daily` = correspondence); result and termination from both players' result codes
 *    (PGN `Result`/`Termination` as fallback); moves from the PGN via chessops; dedupe by game
 *    `uuid`. Chess.com ratings are post-game: `ratingAfter` = rating, and the player's pre-game
 *    `rating` is their previous rated game's rating in the same time class when known, otherwise
 *    the same value. Opponents' titles come from `players_cache` when already looked up.
 * Usernames are lowercased in every URL (mixed case answers 301) and months are zero-padded.
 */
import { parsePgn, type PgnNodeData, type Game } from 'chessops/pgn';
import type { EpochMs, Id, TimeClass, Title } from '@outpost/shared/api';
import {
  chesscomResult,
  chesscomTermination,
  chesscomTimeClass,
  isKnownChesscomCode,
  parseResult,
  playerKey,
  type Color,
  type GameResult,
  type Termination,
} from '@outpost/shared/chess';
import { pgnDateTime, storedTags, terminationFromTag } from '../chess/pgn.ts';
import type { NormalizedGame, NormalizedPlayer } from '../chess/store.ts';
import type { Db } from '../db/index.ts';
import { UPSTREAM, UpstreamError } from '../http/upstream.ts';
import type { JobContext } from '../jobs/handlers.ts';
import { readSettings } from '../settings.ts';
import {
  countryFromChesscom,
  finishSync,
  GameImporter,
  initialCutoff,
  readJsonBody,
  savedSyncState,
  saveSyncState,
  SyncError,
  throwIfAborted,
  titleOrNull,
  type FullResyncMarker,
  type SourceRow,
} from './common.ts';
import { ratingValue, storeSourceProfile, type SourceProfileRating, type SourceProfileSnapshot } from './profile.ts';

export const CHESSCOM_HOST = 'api.chess.com';
/** Chess.com usernames (lowercase in URLs): letters, digits, `_` and `-`. */
export const CHESSCOM_USERNAME_RE = /^[a-z0-9][a-z0-9_-]{1,49}$/;
/** Games per database transaction. */
export const CHESSCOM_BATCH = 100;

const START_SETUP = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq';

/** `/pub/player/{u}` (the fields Outpost reads). */
export interface ChesscomProfile {
  player_id?: number;
  '@id'?: string;
  url?: string;
  username: string;
  title?: string;
  country?: string;
  status?: string;
  joined?: number;
  last_online?: number;
}

/** One game type in `/pub/player/{u}/stats`. */
export interface ChesscomStatsEntry {
  last?: { rating?: number; date?: number; rd?: number };
  best?: { rating?: number; date?: number; game?: string };
  record?: { win?: number; loss?: number; draw?: number };
}

/** `/pub/player/{u}/stats`. */
export interface ChesscomStats {
  chess_bullet?: ChesscomStatsEntry;
  chess_blitz?: ChesscomStatsEntry;
  chess_rapid?: ChesscomStatsEntry;
  chess_daily?: ChesscomStatsEntry;
  fide?: number;
}

/** One side of a game in a monthly archive. */
export interface ChesscomGamePlayer {
  username: string;
  rating?: number;
  result: string;
  '@id'?: string;
  uuid?: string;
}

/** A game in `/pub/player/{u}/games/{YYYY}/{MM}`. */
export interface ChesscomGame {
  url: string;
  pgn?: string;
  time_control?: string;
  end_time?: number;
  start_time?: number;
  rated?: boolean;
  accuracies?: { white?: number; black?: number };
  uuid?: string;
  initial_setup?: string;
  time_class?: string;
  rules?: string;
  white: ChesscomGamePlayer;
  black: ChesscomGamePlayer;
}

/** Why a Chess.com game is not stored. */
export type ChesscomSkipReason = 'variant' | 'fromPosition' | 'otherPlayer' | 'noResult' | 'noMoves' | 'invalid';

const STAT_CLASSES: ReadonlyArray<readonly [keyof ChesscomStats, Exclude<TimeClass, 'unknown'>]> = [
  ['chess_bullet', 'bullet'],
  ['chess_blitz', 'blitz'],
  ['chess_rapid', 'rapid'],
  ['chess_daily', 'correspondence'],
];

/** Display-case username from the profile URL (`…/member/Hikaru`), else the given one. */
export function chesscomDisplayName(profile: Pick<ChesscomProfile, 'url' | 'username'>): string {
  const m = typeof profile.url === 'string' ? /\/member\/([^/?#]+)\/?$/.exec(profile.url) : null;
  const fromUrl = m ? decodeURIComponent(m[1]!) : null;
  return fromUrl && playerKey(fromUrl) === playerKey(profile.username) ? fromUrl : profile.username;
}

/** Profile + stats → `profile_json` snapshot. */
export function chesscomSnapshot(profile: ChesscomProfile, stats: ChesscomStats | null, now: EpochMs): SourceProfileSnapshot {
  const ratings: SourceProfileRating[] = [];
  let all = 0;
  for (const [key, timeClass] of STAT_CLASSES) {
    const e = stats?.[key] as ChesscomStatsEntry | undefined;
    const rating = ratingValue(e?.last?.rating);
    const games = e?.record ? (e.record.win ?? 0) + (e.record.loss ?? 0) + (e.record.draw ?? 0) : null;
    if (games) all += games;
    if (rating === null) continue;
    ratings.push({ timeClass, rating, rd: ratingValue(e?.last?.rd), provisional: false, games, best: ratingValue(e?.best?.rating) });
  }
  const status = profile.status ?? '';
  const countryRaw = typeof profile.country === 'string' ? (/\/country\/([A-Za-z]{2})\/?$/.exec(profile.country)?.[1] ?? null) : null;
  const fide = ratingValue(stats?.fide);
  const username = chesscomDisplayName(profile);
  return {
    v: 1,
    site: 'chesscom',
    fetchedAt: now,
    username,
    userId: typeof profile.player_id === 'number' ? String(profile.player_id) : null,
    url: profile.url ?? `https://www.chess.com/member/${username}`,
    title: titleOrNull(profile.title),
    country: countryFromChesscom(profile.country),
    countryRaw,
    createdAt: typeof profile.joined === 'number' ? profile.joined * 1000 : null,
    seenAt: typeof profile.last_online === 'number' ? profile.last_online * 1000 : null,
    closed: status.startsWith('closed'),
    violation: status === 'closed:fair_play_violations',
    ratings,
    extraRatings: {},
    fide: fide !== null ? { standard: fide, rapid: null, blitz: null } : null,
    counts: stats ? { all, rated: null } : null,
  };
}

/** `YYYY/MM` of an archive URL (`…/games/2026/10`), or null. */
export function archiveMonth(url: unknown): string | null {
  const m = typeof url === 'string' ? /\/games\/(\d{4})\/(\d{2})\/?$/.exec(url) : null;
  return m ? `${m[1]}/${m[2]}` : null;
}

/** `YYYY/MM` (UTC) of an instant, optionally shifted by whole months. */
export function monthOf(t: EpochMs, shift = 0): string {
  const d = new Date(t);
  const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + shift, 1));
  return `${m.getUTCFullYear()}/${String(m.getUTCMonth() + 1).padStart(2, '0')}`;
}

type Pgn = Game<PgnNodeData>;

const tag = (pgn: Pgn | undefined, name: string): string | null => {
  const v = pgn?.headers.get(name)?.trim();
  return v && v !== '?' && v !== '-' ? v : null;
};

/** Stable game id: the archive `uuid`, else `live/<id>` / `daily/<id>` from the URL. */
function gameId(g: ChesscomGame): string | null {
  if (typeof g.uuid === 'string' && g.uuid) return g.uuid;
  const m = typeof g.url === 'string' ? /\/game\/(live|daily)\/(\d+)/.exec(g.url) : null;
  return m ? `${m[1]}/${m[2]}` : null;
}

/** Mapping context: whose archive this is, and what is known about opponents. */
export interface ChesscomMapContext {
  /** The archive owner's key (lowercase username). */
  playerKey: string;
  playerTitle: Title | null;
  /** Title of an opponent already looked up (players_cache), or null. */
  opponentTitle?: (key: string) => Title | null;
  /** Called with result codes Outpost doesn't know (logged by the importer). */
  onUnknownCode?: (code: string) => void;
}

/**
 * Maps a monthly-archive game to a `NormalizedGame` from the archive owner's side (`side`), or
 * says why it is skipped. Ratings are as Chess.com reports them (post-game) on both sides; the
 * importer then replaces the owner's `rating` with the derived pre-game value.
 */
export function mapChesscomGame(
  g: ChesscomGame,
  ctx: ChesscomMapContext,
): { game: NormalizedGame; side: Color } | { skip: ChesscomSkipReason; detail?: string } {
  if (g.rules !== 'chess') return { skip: 'variant', detail: g.rules ?? 'unknown rules' };
  if (!g.white?.username || !g.black?.username) return { skip: 'invalid' };
  if (g.initial_setup && !g.initial_setup.startsWith(`${START_SETUP} `) && g.initial_setup !== START_SETUP) return { skip: 'fromPosition' };
  const whiteKey = playerKey(g.white.username);
  const blackKey = playerKey(g.black.username);
  const side: Color | null = whiteKey === ctx.playerKey ? 'white' : blackKey === ctx.playerKey ? 'black' : null;
  if (!side) return { skip: 'otherPlayer' };
  const id = gameId(g);
  if (!id || typeof g.end_time !== 'number') return { skip: 'invalid' };

  let pgn: Pgn | undefined;
  try {
    pgn = g.pgn ? parsePgn(g.pgn)[0] : undefined;
  } catch {
    pgn = undefined;
  }
  if (!pgn) return { skip: 'noMoves' };
  if (tag(pgn, 'SetUp') === '1' || tag(pgn, 'FEN')) {
    const fen = tag(pgn, 'FEN');
    if (fen && !fen.startsWith(`${START_SETUP} `)) return { skip: 'fromPosition' };
  }
  const moves: string[] = [];
  for (const node of pgn.moves.mainline()) moves.push(node.san);
  if (moves.length === 0) return { skip: 'noMoves' };

  for (const code of [g.white.result, g.black.result]) if (!isKnownChesscomCode(code)) ctx.onUnknownCode?.(code);
  let result: GameResult | null = chesscomResult(g.white.result, g.black.result);
  let termination: Termination;
  if (result) termination = chesscomTermination(g.white.result, g.black.result);
  else {
    result = parseResult(pgn.headers.get('Result'));
    if (!result) return { skip: 'noResult' };
    termination = terminationFromTag(tag(pgn, 'Termination'), result === '1/2-1/2') ?? 'other';
  }

  const player = (p: ChesscomGamePlayer, color: Color): NormalizedPlayer => {
    const rating = ratingValue(p.rating);
    const key = playerKey(p.username);
    const accuracy = g.accuracies?.[color];
    return {
      name: p.username,
      rating,
      ratingAfter: rating,
      title: color === side ? ctx.playerTitle : (ctx.opponentTitle?.(key) ?? null),
      fideId: null,
      accuracy: typeof accuracy === 'number' && Number.isFinite(accuracy) ? accuracy : null,
    };
  };
  const endedAt = g.end_time * 1000;
  const startedAt =
    typeof g.start_time === 'number' ? g.start_time * 1000 : pgnDateTime(tag(pgn, 'UTCDate') ?? tag(pgn, 'Date'), tag(pgn, 'UTCTime'));
  return {
    side,
    game: {
      origin: 'chesscom',
      originId: id,
      url: g.url,
      databaseId: null,
      white: player(g.white, 'white'),
      black: player(g.black, 'black'),
      result,
      termination,
      timeClass: chesscomTimeClass(g.time_class),
      timeControl: g.time_control ?? tag(pgn, 'TimeControl'),
      rated: g.rated === true,
      event: tag(pgn, 'Event'),
      round: tag(pgn, 'Round'),
      startedAt: startedAt !== null && startedAt <= endedAt ? startedAt : endedAt,
      endedAt,
      moves,
      headers: storedTags(pgn.headers),
    },
  };
}

/** `sources.sync_state_json` of a Chess.com source. */
export interface ChesscomSyncState extends FullResyncMarker {
  v: 1;
  /** ETag (or null) of every month fully processed, by `YYYY/MM`. Months missing here are fetched. */
  months: Record<string, string | null>;
  /** Latest month fully processed. */
  doneThrough: string | null;
  /** Start of the first import window (games before it are never imported, except by a full resync). */
  cutoff: EpochMs | null;
  /**
   * When the last completed sync started: every month from the one before it onwards is re-polled
   * next time, so games that ended after it are found however long the gap. Null before the first.
   */
  lastSyncStartedAt: EpochMs | null;
}

/**
 * Months of the archive list a sync fetches: months not processed yet (after the first-import
 * window's start), and every month from the one before the earlier of `lastSyncStartedAt` and
 * `now` onwards (always at least the current and previous month).
 */
export function chesscomMonthsToFetch(
  archive: readonly string[],
  state: Pick<ChesscomSyncState, 'months' | 'cutoff' | 'lastSyncStartedAt'>,
  now: EpochMs,
): string[] {
  const firstMonth = state.cutoff !== null ? monthOf(state.cutoff) : null;
  const repollFrom = monthOf(Math.min(now, state.lastSyncStartedAt ?? now), -1);
  return archive.filter(m => (firstMonth === null || m >= firstMonth) && (!Object.hasOwn(state.months, m) || m >= repollFrom));
}

/** The player's previous rated rating in a time class before `before`, from stored games. */
function storedRatingBefore(db: Db, sourceId: Id, timeClass: TimeClass, before: EpochMs): number | null {
  return (
    db.value<number>(
      `SELECT rating_after FROM player_games
        WHERE source_id = ? AND time_class = ? AND rated = 1 AND rating_after IS NOT NULL AND ended_at < ?
        ORDER BY ended_at DESC LIMIT 1`,
      [sourceId, timeClass, before],
    ) ?? null
  );
}

/** Runs a sync of one Chess.com source (see the file header). Returns the stored state. */
export async function syncChesscom(ctx: JobContext<'sync'>, src: SourceRow): Promise<ChesscomSyncState> {
  const { db, upstream, signal, log } = ctx;
  const key = playerKey(src.key);
  if (!CHESSCOM_USERNAME_RE.test(key)) throw new SyncError(`"${src.key}" is not a valid Chess.com username`);
  const base = `${UPSTREAM.chesscom}/pub/player/${encodeURIComponent(key)}`;
  const startedAt = Date.now();
  const importer = new GameImporter(ctx, src.id, CHESSCOM_BATCH);
  importer.counts.unchangedMonths = 0;
  importer.report(0, null, 'Reading the Chess.com profile');

  const getJson = async <T>(url: string, allow: number[], headers: Record<string, string> = {}): Promise<{ status: number; etag: string | null; body: T | null }> => {
    const res = await upstream.fetch(url, { signal, allowStatuses: allow, headers: { accept: 'application/json', ...headers } });
    if (res.status === 304 || allow.includes(res.status)) {
      void res.body?.cancel().catch(() => {});
      return { status: res.status, etag: res.headers.get('etag'), body: null };
    }
    const body = await readJsonBody<T>(res, CHESSCOM_HOST, signal);
    return { status: res.status, etag: res.headers.get('etag'), body };
  };
  const internalError = (what: string, body: unknown): UpstreamError => {
    const msg = body && typeof body === 'object' && 'message' in body ? `: ${String((body as { message: unknown }).message)}` : '';
    return new UpstreamError('status', CHESSCOM_HOST, `Chess.com sent an unexpected answer for ${what}${msg}`, { status: 503 });
  };

  // 1. Profile and stats.
  const profile = await getJson<ChesscomProfile>(base, [404, 410]);
  if (profile.status === 404 || profile.status === 410) throw new SyncError(`The Chess.com account "${src.display_name}" does not exist`);
  if (!profile.body || typeof profile.body.username !== 'string') throw internalError('the profile', profile.body);
  const stats = await getJson<ChesscomStats>(`${base}/stats`, [404]);
  const snapshot = chesscomSnapshot(profile.body, stats.body, startedAt);
  storeSourceProfile(db, src, snapshot, startedAt);
  const warning = snapshot.violation
    ? `Chess.com closed "${snapshot.username}" for fair-play violations`
    : snapshot.closed
      ? `The Chess.com account "${snapshot.username}" is closed`
      : null;

  // 2. Months to fetch.
  const archives = await getJson<{ archives?: unknown }>(`${base}/games/archives`, [404]);
  if (archives.body !== null && !Array.isArray(archives.body.archives)) throw internalError('the archive list', archives.body);
  const months = [...new Set(((archives.body?.archives as unknown[] | undefined) ?? []).map(archiveMonth).filter((m): m is string => m !== null))].sort();
  const full = ctx.job.payload.full === true;
  const saved = savedSyncState<ChesscomSyncState>(ctx, src.sync_state_json);
  const state: ChesscomSyncState = {
    v: 1,
    months: saved?.months && typeof saved.months === 'object' && !Array.isArray(saved.months) ? { ...saved.months } : {},
    doneThrough: typeof saved?.doneThrough === 'string' ? saved.doneThrough : null,
    cutoff:
      typeof saved?.cutoff === 'number' || (saved && saved.cutoff === null)
        ? (saved.cutoff ?? null)
        : full
          ? null
          : initialCutoff(startedAt, readSettings(db, ctx.config).initialSyncMonths),
    // States written before this field existed: the source's last completed sync is close enough.
    lastSyncStartedAt:
      typeof saved?.lastSyncStartedAt === 'number' ? saved.lastSyncStartedAt : saved ? (src.last_synced_at ?? null) : null,
    ...(full ? { fullJob: ctx.job.id } : {}),
  };
  const toFetch = chesscomMonthsToFetch(months, state, startedAt);

  // 3. Each month, oldest first.
  const prevRated = new Map<TimeClass, number>();
  const titleCache = new Map<string, Title | null>();
  const unknownCodes = new Set<string>();
  const mapCtx: ChesscomMapContext = {
    playerKey: key,
    playerTitle: snapshot.title,
    opponentTitle: k => {
      if (!titleCache.has(k)) {
        const t = db.value<string | null>("SELECT title FROM players_cache WHERE kind = 'chesscom' AND key = ?", [k]);
        titleCache.set(k, titleOrNull(t));
      }
      return titleCache.get(k) ?? null;
    },
    onUnknownCode: code => {
      if (!unknownCodes.has(code)) log.warn({ code }, 'unknown Chess.com result code (counted as a loss)');
      unknownCodes.add(code);
    },
  };
  let seen = 0;
  for (const [i, month] of toFetch.entries()) {
    throwIfAborted(signal);
    importer.report(i, toFetch.length, `${month.replace('/', '-')}: ${importer.counts.imported} new games so far`);
    const known = state.months[month];
    const res = await getJson<{ games?: unknown }>(`${base}/games/${month}`, [404], known ? { 'if-none-match': known } : {});
    const done = (etag: string | null): void => {
      state.months[month] = etag;
      if (state.doneThrough === null || month > state.doneThrough) state.doneThrough = month;
    };
    if (res.status === 304) {
      importer.counts.unchangedMonths!++;
      done(known ?? null);
      saveSyncState(db, src.id, state);
      continue;
    }
    if (res.status === 404) {
      // Listed in the archive but not served: leave it unprocessed so the next sync asks again.
      importer.counts.missingMonths = (importer.counts.missingMonths ?? 0) + 1;
      log.warn({ month }, 'Chess.com listed a month it does not serve (will retry next sync)');
      continue;
    }
    if (!res.body || !Array.isArray(res.body.games)) throw internalError(`games of ${month}`, res.body);
    const games = (res.body.games as ChesscomGame[]).filter(g => g && typeof g === 'object').sort((a, b) => (a.end_time ?? 0) - (b.end_time ?? 0));
    for (const g of games) {
      seen++;
      const mapped = mapChesscomGame(g, mapCtx);
      if ('skip' in mapped) {
        importer.skip();
        continue;
      }
      const { game, side } = mapped;
      const me = game[side];
      // Chess.com ratings are post-game: the pre-game rating is the previous rated game's in this class.
      if (game.rated && me.ratingAfter !== null) {
        const prev = prevRated.has(game.timeClass)
          ? prevRated.get(game.timeClass)!
          : storedRatingBefore(db, src.id, game.timeClass, game.endedAt!);
        me.rating = prev ?? me.ratingAfter;
        prevRated.set(game.timeClass, me.ratingAfter);
      }
      if (state.cutoff !== null && game.endedAt! < state.cutoff) continue;
      if (importer.add(game)) await importer.flush(() => saveSyncState(db, src.id, state));
    }
    done(res.etag);
    await importer.flush(() => saveSyncState(db, src.id, state));
    importer.report(i + 1, toFetch.length, `${month.replace('/', '-')}: ${importer.counts.imported} new games so far`);
  }
  if (unknownCodes.size) importer.counts.unknownResultCodes = unknownCodes.size;
  state.lastSyncStartedAt = startedAt;
  delete state.fullJob;
  finishSync(db, src.id, state, warning, Date.now());
  importer.report(toFetch.length, toFetch.length, `${importer.counts.imported} new game${importer.counts.imported === 1 ? '' : 's'} imported (${seen} checked)`);
  return state;
}
