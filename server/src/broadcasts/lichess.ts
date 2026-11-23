/**
 * Official Lichess broadcasts through `app.upstream` (always with the token: PR #21283 asks every
 * broadcast API client to authenticate) and their mapping to the contract types — PLAN §5 (Live
 * broadcasts), §6, research lichess-api.md §4.
 *
 * Upstream shapes (checked 2026-11-23):
 * - `GET /api/broadcast/top?page=` `{active[], upcoming[], past:{currentPage, maxPerPage,
 *   currentPageResults[], previousPage, nextPage}}`, each entry `{tour, round, roundToLink?, group?}`:
 *   `active` are the tours Lichess shows as ongoing (by tier), with their current or next `round`
 *   and, when that one has no games yet, `roundToLink` = the latest round with games; `upcoming`
 *   have not started; `past` are finished tours, most recent first, with their last round (24 a
 *   page). The list does not carry every round of a tour: `GET /api/broadcast/{tourId}` does.
 *   (`GET /api/broadcast?nb=` is not used: it lists 100+ unfinished tours before any finished one.)
 * - `GET /api/broadcast/{tourId}` `{tour, rounds[], defaultRoundId?, group?}`;
 * - `GET /api/broadcast/-/-/{roundId}` `{round, tour, study, games[]}` where a game preview is
 *   `{id, name, fen, players[2]{name,title,rating,fideId,fed,clock (centiseconds)}, lastMove (UCI),
 *   check, thinkTime (s), status ('*', '1-0', '0-1', '½-½')}`;
 * - `GET /api/broadcast/round/{roundId}.pgn` the round's games.
 *
 * Every failure is an `UpstreamError` (body reads too, so routes answer 502/503, never 500) or a
 * 404 `HttpError`.
 */
import type {
  BroadcastGamePreview,
  BroadcastPlayer,
  BroadcastRound,
  BroadcastRoundRef,
  BroadcastsResponse,
  BroadcastSummary,
  Title,
} from '@outpost/shared/api';
import { isTitle, parseResult } from '@outpost/shared/chess';
import { notFound } from '../http/errors.ts';
import { UPSTREAM, UpstreamError, type Upstream } from '../http/upstream.ts';

/** Lichess broadcast tour and round ids: 8 letters or digits. */
export const BROADCAST_ID_RE = /^[A-Za-z0-9]{8}$/;

/** Standard start position (previews of games that have not started carry no FEN). */
export const INITIAL_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** Largest round PGN served from upstream (a 400-board round with clocks and comments is ~2 MB). */
export const MAX_ROUND_PGN_BYTES = 8 * 1024 * 1024;
/** Largest JSON answer read (the top list is ~100 kB, a 400-board round's previews ~300 kB). */
export const MAX_BROADCAST_JSON_BYTES = 8 * 1024 * 1024;

const LICHESS_HOST = new URL(UPSTREAM.lichess).host;

// ---------------------------------------------------------------------------
// Upstream shapes (only the fields Outpost reads; everything is checked at runtime)
// ---------------------------------------------------------------------------

/** A tour as Lichess sends it. */
export interface LichessTour {
  id: string;
  name: string;
  slug: string;
  info?: Record<string, unknown>;
  url?: string;
  tier?: number;
  dates?: number[];
  description?: string;
}

/** A round as Lichess sends it. */
export interface LichessRound {
  id: string;
  name: string;
  slug: string;
  startsAt?: number;
  finishedAt?: number;
  finished?: boolean;
  ongoing?: boolean;
  url?: string;
}

/** `GET /api/broadcast` line, `GET /api/broadcast/{tourId}`. */
export interface LichessTourWithRounds {
  tour: LichessTour;
  rounds: LichessRound[];
  defaultRoundId?: string;
}

/** An entry of `GET /api/broadcast/top`. */
export interface LichessTopEntry {
  tour: LichessTour;
  /** The tour's current or next round (active), or its last round (past). */
  round: LichessRound | null;
  /** The latest round with games when `round` has none yet. */
  roundToLink: LichessRound | null;
  group: string | null;
}

/** `GET /api/broadcast/top`. */
export interface LichessTop {
  active: LichessTopEntry[];
  upcoming: LichessTopEntry[];
  /** Finished tours of the requested page, most recent first. */
  past: LichessTopEntry[];
  /** Next page of `past`, or null on the last one. */
  nextPastPage: number | null;
}

/** A game preview player. */
export interface LichessPreviewPlayer {
  name?: string;
  title?: string;
  rating?: number;
  fideId?: number | string;
  fed?: string;
  /** Centiseconds. */
  clock?: number;
}

/** A game preview of a round. */
export interface LichessGamePreview {
  id: string;
  name?: string;
  fen?: string;
  players?: LichessPreviewPlayer[];
  lastMove?: string;
  check?: string;
  thinkTime?: number;
  status?: string;
}

/** `GET /api/broadcast/-/-/{roundId}`. */
export interface LichessRoundResponse {
  round: LichessRound;
  tour: LichessTour;
  games: LichessGamePreview[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function parseTour(v: unknown): LichessTour | null {
  if (!isObj(v)) return null;
  const id = str(v.id);
  const name = str(v.name);
  if (!id || !name) return null;
  return {
    id,
    name,
    slug: str(v.slug) ?? '-',
    ...(isObj(v.info) ? { info: v.info } : {}),
    ...(str(v.url) ? { url: v.url as string } : {}),
    ...(num(v.tier) !== null ? { tier: v.tier as number } : {}),
    ...(Array.isArray(v.dates) ? { dates: v.dates.filter((d): d is number => num(d) !== null) } : {}),
    ...(str(v.description) ? { description: v.description as string } : {}),
  };
}

function parseRound(v: unknown): LichessRound | null {
  if (!isObj(v)) return null;
  const id = str(v.id);
  if (!id) return null;
  return {
    id,
    name: str(v.name) ?? id,
    slug: str(v.slug) ?? '-',
    ...(num(v.startsAt) !== null ? { startsAt: v.startsAt as number } : {}),
    ...(num(v.finishedAt) !== null ? { finishedAt: v.finishedAt as number } : {}),
    ...(v.finished === true ? { finished: true } : {}),
    ...(v.ongoing === true ? { ongoing: true } : {}),
    ...(str(v.url) ? { url: v.url as string } : {}),
  };
}

/** Validates a tour-with-rounds object, or null when it is unusable. */
export function parseTourWithRounds(v: unknown): LichessTourWithRounds | null {
  if (!isObj(v)) return null;
  const tour = parseTour(v.tour);
  if (!tour) return null;
  const rounds = Array.isArray(v.rounds) ? v.rounds.map(parseRound).filter((r): r is LichessRound => r !== null) : [];
  return { tour, rounds, ...(str(v.defaultRoundId) ? { defaultRoundId: v.defaultRoundId as string } : {}) };
}

function parseTopEntry(v: unknown): LichessTopEntry | null {
  if (!isObj(v)) return null;
  const tour = parseTour(v.tour);
  if (!tour) return null;
  return { tour, round: parseRound(v.round), roundToLink: parseRound(v.roundToLink), group: str(v.group) };
}

/** Validates a `GET /api/broadcast/top` answer, or null when it is unusable. */
export function parseTop(v: unknown): LichessTop | null {
  if (!isObj(v) || (!Array.isArray(v.active) && !isObj(v.past))) return null;
  const entries = (x: unknown): LichessTopEntry[] =>
    Array.isArray(x) ? x.map(parseTopEntry).filter((e): e is LichessTopEntry => e !== null) : [];
  const past = isObj(v.past) ? v.past : {};
  const next = num(past.nextPage);
  return {
    active: entries(v.active),
    upcoming: entries(v.upcoming),
    past: entries(past.currentPageResults),
    nextPastPage: next !== null && next > 0 ? next : null,
  };
}

/** Validates a round response, or null when it is unusable. */
export function parseRoundResponse(v: unknown): LichessRoundResponse | null {
  if (!isObj(v)) return null;
  const round = parseRound(v.round);
  const tour = parseTour(v.tour);
  if (!round || !tour) return null;
  const games: LichessGamePreview[] = [];
  for (const g of Array.isArray(v.games) ? v.games : []) {
    if (!isObj(g) || !str(g.id)) continue;
    games.push({
      id: g.id as string,
      ...(str(g.name) ? { name: g.name as string } : {}),
      ...(str(g.fen) ? { fen: g.fen as string } : {}),
      ...(Array.isArray(g.players) ? { players: g.players.map(p => (isObj(p) ? (p as LichessPreviewPlayer) : {})) } : {}),
      ...(str(g.lastMove) ? { lastMove: g.lastMove as string } : {}),
      ...(num(g.thinkTime) !== null ? { thinkTime: g.thinkTime as number } : {}),
      ...(str(g.status) ? { status: g.status as string } : {}),
    });
  }
  return { round, tour, games };
}

// ---------------------------------------------------------------------------
// Mapping to the contract
// ---------------------------------------------------------------------------

const INFO_KEYS = ['format', 'tc', 'fideTC', 'location', 'players', 'website'] as const;

/** A round of a tour as `BroadcastRoundRef`. */
export function toRoundRef(tour: Pick<LichessTour, 'slug'>, r: LichessRound): BroadcastRoundRef {
  return {
    id: r.id,
    name: r.name,
    slug: r.slug,
    startsAt: r.startsAt ?? null,
    finished: r.finished === true,
    ongoing: r.ongoing === true,
    url: r.url ?? `${UPSTREAM.lichess}/broadcast/${tour.slug || '-'}/${r.slug || '-'}/${r.id}`,
  };
}

/** The round to open first: Lichess's choice, else the ongoing one, the last finished one, or the first. */
function defaultRound(t: LichessTourWithRounds): string | null {
  if (t.defaultRoundId && t.rounds.some(r => r.id === t.defaultRoundId)) return t.defaultRoundId;
  const ongoing = t.rounds.find(r => r.ongoing);
  if (ongoing) return ongoing.id;
  const finished = t.rounds.filter(r => r.finished);
  return finished.at(-1)?.id ?? t.rounds[0]?.id ?? null;
}

/** A tour with its rounds as `BroadcastSummary`. */
export function toBroadcastSummary(t: LichessTourWithRounds): BroadcastSummary {
  const info: BroadcastSummary['tour']['info'] = {};
  for (const k of INFO_KEYS) {
    const v = str(t.tour.info?.[k]);
    if (v) info[k] = v;
  }
  return {
    tour: {
      id: t.tour.id,
      name: t.tour.name,
      slug: t.tour.slug,
      tier: t.tour.tier ?? null,
      dates: t.tour.dates ?? [],
      url: t.tour.url ?? `${UPSTREAM.lichess}/broadcast/${t.tour.slug || '-'}/${t.tour.id}`,
      description: t.tour.description ?? null,
      info,
    },
    rounds: t.rounds.map(r => toRoundRef(t.tour, r)),
    defaultRoundId: defaultRound(t),
    live: t.rounds.some(r => r.ongoing === true),
  };
}

/**
 * A top-list entry as `BroadcastSummary`: its rounds are only the latest round with games and the
 * current/next (or last) round, and the summary opens the one with games.
 */
export function topEntrySummary(e: LichessTopEntry): BroadcastSummary {
  const rounds: LichessRound[] = [];
  for (const r of [e.roundToLink, e.round]) if (r && !rounds.some(x => x.id === r.id)) rounds.push(r);
  const [a, b] = rounds;
  if (a && b && a.startsAt !== undefined && b.startsAt !== undefined && b.startsAt < a.startsAt) rounds.reverse();
  const defaultRoundId = e.roundToLink?.id ?? e.round?.id;
  return toBroadcastSummary({ tour: e.tour, rounds, ...(defaultRoundId ? { defaultRoundId } : {}) });
}

/**
 * `GET /api/broadcasts` from the top list: active tours (live ones first, otherwise Lichess's tier
 * order), upcoming ones, and the most recently finished ones as `recent`. A tour shows once.
 */
export function toBroadcastsResponse(top: LichessTop): BroadcastsResponse {
  const seen = new Set<string>();
  const pick = (entries: readonly LichessTopEntry[]): BroadcastSummary[] => {
    const out: BroadcastSummary[] = [];
    for (const e of entries) {
      if (seen.has(e.tour.id)) continue;
      seen.add(e.tour.id);
      out.push(topEntrySummary(e));
    }
    return out;
  };
  const active = pick(top.active).sort((a, b) => Number(b.live) - Number(a.live));
  const upcoming = pick(top.upcoming);
  const recent = pick(top.past);
  return { active, recent, upcoming };
}

const fideIdOf = (v: unknown): string | null => {
  const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : '';
  return /^[1-9]\d{0,11}$/.test(s) ? s : null;
};

/** A preview player as `BroadcastPlayer` (clock centiseconds → seconds). */
export function toBroadcastPlayer(p: LichessPreviewPlayer | undefined): BroadcastPlayer {
  const title = p?.title?.toUpperCase();
  const fed = str(p?.fed)?.toUpperCase() ?? null;
  const rating = num(p?.rating);
  const clock = num(p?.clock);
  return {
    name: str(p?.name)?.trim() ?? '?',
    title: isTitle(title) ? (title as Title) : null,
    rating: rating !== null && rating > 0 ? Math.round(rating) : null,
    fideId: fideIdOf(p?.fideId),
    fed: fed && /^[A-Z]{3}$/.test(fed) ? fed : null,
    clock: clock !== null && clock >= 0 ? Math.round(clock / 100) : null,
  };
}

const SQUARE_FILES = 'abcdefgh';

/** The piece on a square of a FEN board (`K`, `p`…), or null when empty / invalid. */
function pieceAt(fen: string, square: string): string | null {
  const rows = fen.split(' ')[0]?.split('/');
  if (!rows || rows.length !== 8) return null;
  const file = SQUARE_FILES.indexOf(square[0]!);
  const rank = Number(square[1]);
  const row = rows[8 - rank];
  if (file < 0 || !row) return null;
  let col = 0;
  for (const c of row) {
    if (/\d/.test(c)) col += Number(c);
    else {
      if (col === file) return c;
      col++;
    }
    if (col > file) return null;
  }
  return null;
}

/**
 * Last move in standard castling notation: Lichess may send king-takes-rook (`e1h1`); after castling
 * the king stands on g/c and the rook's square is empty, which tells it apart from a rook move.
 */
export function standardLastMove(uci: string | null | undefined, fen: string): string | null {
  if (!uci || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) return null;
  const castles: Record<string, [string, string]> = {
    e1h1: ['e1g1', 'g1'],
    e1a1: ['e1c1', 'c1'],
    e8h8: ['e8g8', 'g8'],
    e8a8: ['e8c8', 'c8'],
  };
  const c = castles[uci];
  if (!c) return uci;
  const king = uci[1] === '1' ? 'K' : 'k';
  return pieceAt(fen, c[1]) === king && pieceAt(fen, uci.slice(2, 4)) === null ? c[0] : uci;
}

/** A game preview as `BroadcastGamePreview`. */
export function toGamePreview(g: LichessGamePreview): BroadcastGamePreview {
  const fen = g.fen ?? INITIAL_FEN;
  const white = toBroadcastPlayer(g.players?.[0]);
  const black = toBroadcastPlayer(g.players?.[1]);
  const status = g.status === '*' || !g.status ? '*' : (parseResult(g.status) ?? '*');
  const think = num(g.thinkTime);
  return {
    id: g.id,
    name: g.name ?? `${white.name} - ${black.name}`,
    white,
    black,
    fen,
    lastMove: standardLastMove(g.lastMove, fen),
    status,
    thinkTime: status === '*' && think !== null && think >= 0 ? Math.round(think) : null,
  };
}

/** A round response as `BroadcastRound`. */
export function toBroadcastRound(r: LichessRoundResponse, fetchedAt: number): BroadcastRound {
  return {
    tour: { id: r.tour.id, name: r.tour.name, slug: r.tour.slug },
    round: toRoundRef(r.tour, r.round),
    games: r.games.map(toGamePreview),
    fetchedAt,
  };
}

/** FIDE id → federation of the players in a round's previews. */
export function federationsOf(r: LichessRoundResponse): Map<string, string> {
  const out = new Map<string, string>();
  for (const g of r.games) {
    for (const p of g.players ?? []) {
      const pl = toBroadcastPlayer(p);
      if (pl.fideId && pl.fed) out.set(pl.fideId, pl.fed);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Upstream calls (token required; failures are UpstreamErrors or 404 HttpErrors)
// ---------------------------------------------------------------------------

const invalid = (what: string): UpstreamError => new UpstreamError('status', LICHESS_HOST, `Unexpected ${what} from lichess.org`);

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Reads a body as text, at most `max` bytes. A larger body is `UpstreamError('status')` (502); a
 * body that breaks off or stalls past the caller's deadline is `'network'` / `'timeout'` (503).
 */
export async function readUpstreamText(
  res: Response,
  what: string,
  opts: { max?: number; signal?: AbortSignal } = {},
): Promise<string> {
  const max = opts.max ?? MAX_BROADCAST_JSON_BYTES;
  const tooLarge = () => new UpstreamError('status', LICHESS_HOST, `The ${what} from lichess.org is larger than ${max} bytes`, { status: res.status });
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) {
    void res.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  const reader = res.body?.getReader();
  if (!reader) return '';
  // The deadline is raced here too, so a body stream that ignores the signal cannot stall the read.
  const signal = opts.signal;
  let onAbort: (() => void) | undefined;
  const aborted = signal
    ? new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      })
    : null;
  aborted?.catch(() => {});
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await (aborted ? Promise.race([reader.read(), aborted]) : reader.read());
      if (done) break;
      total += value.byteLength;
      if (total > max) throw tooLarge();
      chunks.push(value);
    }
  } catch (e) {
    void reader.cancel().catch(() => {});
    if (e instanceof UpstreamError) throw e;
    const reason = signal?.aborted ? ((signal.reason as Error | undefined)?.name === 'TimeoutError' ? 'timeout' : 'aborted') : 'network';
    throw new UpstreamError(reason, LICHESS_HOST, `Reading the ${what} from lichess.org failed: ${errorText(e)}`, { cause: e });
  } finally {
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Reads and parses a JSON body (see `readUpstreamText`); unparsable → `UpstreamError('status')`. */
async function readUpstreamJson(res: Response, what: string, signal?: AbortSignal): Promise<unknown> {
  const text = await readUpstreamText(res, what, signal ? { signal } : {});
  try {
    return JSON.parse(text);
  } catch {
    throw invalid(what);
  }
}

/** A Lichess GET with the token; 404 → `not_found` (`notFoundMessage`) when given. */
async function lichessGet(
  upstream: Upstream,
  url: string,
  opts: { accept: string; signal?: AbortSignal | undefined; notFound?: string; timeoutMs?: number },
): Promise<Response> {
  const res = await upstream.fetch(url, {
    auth: 'required',
    headers: { accept: opts.accept },
    ...(opts.notFound ? { allowStatuses: [404] } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
  });
  if (res.status === 404 && opts.notFound) {
    void res.body?.cancel().catch(() => {});
    throw notFound(opts.notFound);
  }
  return res;
}

/** `GET /api/broadcast/top?page=`: active, upcoming and (one page of) finished official tours. */
export async function fetchTopBroadcasts(upstream: Upstream, opts: { page?: number; signal?: AbortSignal } = {}): Promise<LichessTop> {
  const page = Math.max(1, Math.floor(opts.page ?? 1));
  const res = await lichessGet(upstream, `${UPSTREAM.lichess}/api/broadcast/top?page=${page}`, {
    accept: 'application/json',
    signal: opts.signal,
  });
  const top = parseTop(await readUpstreamJson(res, 'broadcast list', opts.signal));
  if (!top) throw invalid('broadcast list');
  return top;
}

/** `GET /api/broadcast/{tourId}`; 404 → `not_found`. */
export async function fetchTour(upstream: Upstream, tourId: string, signal?: AbortSignal): Promise<LichessTourWithRounds> {
  const res = await lichessGet(upstream, `${UPSTREAM.lichess}/api/broadcast/${encodeURIComponent(tourId)}`, {
    accept: 'application/json',
    signal,
    notFound: 'Broadcast not found',
  });
  const t = parseTourWithRounds(await readUpstreamJson(res, 'broadcast tour', signal));
  if (!t) throw invalid('broadcast tour');
  return t;
}

/** `GET /api/broadcast/-/-/{roundId}`; 404 → `not_found`. */
export async function fetchRound(upstream: Upstream, roundId: string, signal?: AbortSignal): Promise<LichessRoundResponse> {
  const res = await lichessGet(upstream, `${UPSTREAM.lichess}/api/broadcast/-/-/${encodeURIComponent(roundId)}`, {
    accept: 'application/json',
    signal,
    notFound: 'Broadcast round not found',
  });
  const r = parseRoundResponse(await readUpstreamJson(res, 'broadcast round', signal));
  if (!r) throw invalid('broadcast round');
  return r;
}

/** URL of a round's PGN export (clocks and comments off unless asked for). */
export function roundPgnUrl(roundId: string, opts: { clocks?: boolean; comments?: boolean } = {}): string {
  const q = new URLSearchParams({ clocks: String(opts.clocks ?? false), comments: String(opts.comments ?? false) });
  return `${UPSTREAM.lichess}/api/broadcast/round/${encodeURIComponent(roundId)}.pgn?${q}`;
}

/** `GET /api/broadcast/round/{roundId}.pgn` (mainline only unless asked: no clocks or comments); 404 → `not_found`. */
export async function fetchRoundPgn(
  upstream: Upstream,
  roundId: string,
  opts: { signal?: AbortSignal; clocks?: boolean; comments?: boolean; timeoutMs?: number } = {},
): Promise<Response> {
  return lichessGet(upstream, roundPgnUrl(roundId, opts), {
    accept: 'application/x-chess-pgn',
    signal: opts.signal,
    notFound: 'Broadcast round not found',
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
  });
}
