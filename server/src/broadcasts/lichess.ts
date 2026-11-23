/**
 * Official Lichess broadcasts through `app.upstream` (always with the token: PR #21283 asks every
 * broadcast API client to authenticate) and their mapping to the contract types — PLAN §5 (Live
 * broadcasts), §6, research lichess-api.md §4.
 *
 * Upstream shapes (checked 2026-11-23):
 * - `GET /api/broadcast?nb=` NDJSON lines `{tour, rounds[], defaultRoundId, group?}`, active tours
 *   first (by tier), then finished ones by most recent sync;
 * - `GET /api/broadcast/{tourId}` `{tour, rounds[], defaultRoundId?, group?}`;
 * - `GET /api/broadcast/-/-/{roundId}` `{round, tour, study, games[]}` where a game preview is
 *   `{id, name, fen, players[2]{name,title,rating,fideId,fed,clock (centiseconds)}, lastMove (UCI),
 *   check, thinkTime (s), status ('*', '1-0', '0-1', '½-½')}`;
 * - `GET /api/broadcast/round/{roundId}.pgn` the round's games.
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

/** Tours requested for `GET /api/broadcasts` (active ones come first upstream). */
export const BROADCAST_LIST_SIZE = 80;
/** Finished tours shown under "recent". */
export const RECENT_BROADCASTS = 20;
/** Largest round PGN accepted from upstream. */
export const MAX_ROUND_PGN_BYTES = 64 * 1024 * 1024;

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

/** A tour is finished when it has rounds and all of them are finished. */
export const isFinishedTour = (t: LichessTourWithRounds): boolean => t.rounds.length > 0 && t.rounds.every(r => r.finished);

/** Splits the official list into active (live or upcoming) and recently finished tours. */
export function toBroadcastsResponse(list: readonly LichessTourWithRounds[]): BroadcastsResponse {
  const active: BroadcastSummary[] = [];
  const recent: BroadcastSummary[] = [];
  const seen = new Set<string>();
  for (const t of list) {
    if (seen.has(t.tour.id)) continue;
    seen.add(t.tour.id);
    if (isFinishedTour(t)) {
      if (recent.length < RECENT_BROADCASTS) recent.push(toBroadcastSummary(t));
    } else active.push(toBroadcastSummary(t));
  }
  // Live tours first, keeping Lichess's order (tier) otherwise.
  active.sort((a, b) => Number(b.live) - Number(a.live));
  return { active, recent };
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

const invalid = (what: string): UpstreamError =>
  new UpstreamError('status', new URL(UPSTREAM.lichess).host, `Unexpected ${what} from lichess.org`);

/** `GET /api/broadcast?nb=`: official tours, active ones first. */
export async function fetchOfficialBroadcasts(
  upstream: Upstream,
  opts: { nb?: number; signal?: AbortSignal } = {},
): Promise<LichessTourWithRounds[]> {
  const nb = Math.max(1, Math.min(100, opts.nb ?? BROADCAST_LIST_SIZE));
  const res = await upstream.fetch(`${UPSTREAM.lichess}/api/broadcast?nb=${nb}`, {
    auth: 'required',
    headers: { accept: 'application/x-ndjson' },
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  const text = await res.text();
  const out: LichessTourWithRounds[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      throw invalid('broadcast list');
    }
    const t = parseTourWithRounds(v);
    if (t) out.push(t);
  }
  return out;
}

/** `GET /api/broadcast/{tourId}`; 404 → `not_found`. */
export async function fetchTour(upstream: Upstream, tourId: string, signal?: AbortSignal): Promise<LichessTourWithRounds> {
  const res = await upstream.fetch(`${UPSTREAM.lichess}/api/broadcast/${encodeURIComponent(tourId)}`, {
    auth: 'required',
    headers: { accept: 'application/json' },
    allowStatuses: [404],
    ...(signal ? { signal } : {}),
  });
  if (res.status === 404) {
    void res.body?.cancel().catch(() => {});
    throw notFound('Broadcast not found');
  }
  const t = parseTourWithRounds(await res.json().catch(() => null));
  if (!t) throw invalid('broadcast tour');
  return t;
}

/** `GET /api/broadcast/-/-/{roundId}`; 404 → `not_found`. */
export async function fetchRound(upstream: Upstream, roundId: string, signal?: AbortSignal): Promise<LichessRoundResponse> {
  const res = await upstream.fetch(`${UPSTREAM.lichess}/api/broadcast/-/-/${encodeURIComponent(roundId)}`, {
    auth: 'required',
    headers: { accept: 'application/json' },
    allowStatuses: [404],
    ...(signal ? { signal } : {}),
  });
  if (res.status === 404) {
    void res.body?.cancel().catch(() => {});
    throw notFound('Broadcast round not found');
  }
  const r = parseRoundResponse(await res.json().catch(() => null));
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
  const res = await upstream.fetch(roundPgnUrl(roundId, opts), {
    auth: 'required',
    headers: { accept: 'application/x-chess-pgn' },
    allowStatuses: [404],
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
  });
  if (res.status === 404) {
    void res.body?.cancel().catch(() => {});
    throw notFound('Broadcast round not found');
  }
  return res;
}
