/**
 * Query schemas of the explorer endpoints and the normalised upstream queries built from them.
 *
 * Schemas strip unknown keys (never `.strict()`): lila sends extras such as `source=analysis`.
 * Upstream queries are rebuilt from validated values in a fixed key order, so equal requests share
 * one cache entry and nothing unvalidated reaches Lichess.
 */
import { parseFen } from 'chessops/fen';
import { parseUci } from 'chessops/util';
import { normalizeMove, setupPosition } from 'chessops/variant';
import type { Rules } from 'chessops/types';
import { z } from 'zod';
import { validationError } from '../http/errors.ts';
import { MAX_FEN_LENGTH, MAX_PLAY_MOVES, normalizeFen, parseStandardFen } from './position.ts';
import { parseStdUci } from '@outpost/shared/chess';

const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);
const monthOrYear = z.string().trim().regex(/^\d{4}(-(0[1-9]|1[0-2]))?$/, 'expected YYYY or YYYY-MM');
const shortText = (max: number) => z.string().max(max);

/** Lichess explorer variants and their chessops rules. */
export const LICHESS_VARIANTS: Readonly<Record<string, Rules>> = {
  standard: 'chess',
  chess960: 'chess',
  fromPosition: 'chess',
  crazyhouse: 'crazyhouse',
  antichess: 'antichess',
  atomic: 'atomic',
  horde: 'horde',
  kingOfTheHill: 'kingofthehill',
  racingKings: 'racingkings',
  threeCheck: '3check',
};

/** Variants tablebase.lichess.ovh answers. */
export const TABLEBASE_VARIANTS = ['standard', 'atomic', 'antichess'] as const;
/** Most pieces lila asks the tablebase about (lila: `pieceCount − 1 ≤ 8`, or 6 for atomic/antichess). */
export const TABLEBASE_MAX_PIECES: Record<(typeof TABLEBASE_VARIANTS)[number], number> = { standard: 9, atomic: 7, antichess: 7 };

const LICHESS_SPEEDS = ['ultraBullet', 'bullet', 'blitz', 'rapid', 'classical', 'correspondence'] as const;

/** `GET /api/explorer/player` (and `/f/:filters/player`). */
export const playerQuerySchema = z.object({
  player: z.string().trim().min(1).max(120),
  color: z.enum(['white', 'black']),
  variant: shortText(30).optional(),
  fen: shortText(MAX_FEN_LENGTH * 2).optional(),
  play: shortText(MAX_PLAY_MOVES * 6).optional(),
  speeds: shortText(200).optional(),
  modes: shortText(50).optional(),
  since: shortText(20).optional(),
  until: shortText(20).optional(),
  moves: int(0, 1000).optional(),
  recentGames: int(0, 1000).optional(),
});

/** `GET /api/explorer/reference` (and a reference-backed masters explorer). */
export const referenceQuerySchema = z.object({
  fen: shortText(MAX_FEN_LENGTH * 2).optional(),
  play: shortText(MAX_PLAY_MOVES * 6).optional(),
  speeds: shortText(200).optional(),
  modes: shortText(50).optional(),
  since: shortText(20).optional(),
  until: shortText(20).optional(),
  moves: int(0, 1000).optional(),
  topGames: int(0, 1000).optional(),
});

/** `GET /api/explorer/games` (filters are read separately with `parseFiltersQuery`). */
export const gamesQuerySchema = z.object({
  player: z.string().trim().min(1).max(120),
  fen: shortText(MAX_FEN_LENGTH * 2).optional(),
  play: shortText(MAX_PLAY_MOVES * 6).optional(),
  speeds: shortText(200).optional(),
  modes: shortText(50).optional(),
  since: shortText(20).optional(),
  until: shortText(20).optional(),
  page: int(1, 100_000).default(1),
  pageSize: int(1, 100).default(20),
});

/** `GET /api/explorer/masters` as lila sends it (the year-only `since`/`until`). */
export const mastersQuerySchema = z.object({
  fen: shortText(MAX_FEN_LENGTH * 2).optional(),
  play: shortText(MAX_PLAY_MOVES * 6).optional(),
  since: monthOrYear.optional(),
  until: monthOrYear.optional(),
  moves: int(0, 100).optional(),
  topGames: int(0, 15).optional(),
});

/** `GET /api/explorer/lichess`. */
export const lichessQuerySchema = z.object({
  variant: z.enum(Object.keys(LICHESS_VARIANTS) as [string, ...string[]]).optional(),
  fen: shortText(MAX_FEN_LENGTH * 2).optional(),
  play: shortText(MAX_PLAY_MOVES * 8).optional(),
  speeds: shortText(200).optional(),
  ratings: shortText(200).optional(),
  since: monthOrYear.optional(),
  until: monthOrYear.optional(),
  moves: int(0, 100).optional(),
  topGames: int(0, 4).optional(),
  recentGames: int(0, 4).optional(),
  history: z.enum(['true', 'false']).optional(),
});

/** `GET /api/explorer/masters/pgn/:id`: a Lichess masters id, or an Outpost game (`op<id>`). */
export const mastersPgnParamsSchema = z.object({
  id: z.string().regex(/^(op[1-9]\d{0,15}|[A-Za-z0-9]{8})$/, 'expected a masters game id'),
});

/** `GET /api/tablebase/:variant`. */
export const tablebaseParamsSchema = z.object({ variant: z.enum(TABLEBASE_VARIANTS) });
export const tablebaseQuerySchema = z.object({ fen: z.string().trim().min(1).max(MAX_FEN_LENGTH * 2) });

/** `GET /api/cloud-eval`. */
export const cloudEvalQuerySchema = z.object({
  fen: z.string().trim().min(1).max(MAX_FEN_LENGTH * 2),
  multiPv: int(1, 5).default(1),
  variant: z.enum(Object.keys(LICHESS_VARIANTS) as [string, ...string[]]).optional(),
});

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const csv = (s: string | undefined): string[] =>
  (s ?? '')
    .split(',')
    .map(x => x.trim())
    .filter(x => x !== '');

/** Validates a standard-chess `fen` + `play` (legal moves), returning the normalised values. */
export function checkStandardLine(fen: string | undefined, play: string | undefined): { fen: string | null; play: string[] } {
  const pos = parseStandardFen(fen);
  const moves = csv(play);
  if (moves.length > MAX_PLAY_MOVES) throw validationError(`play: at most ${MAX_PLAY_MOVES} moves`);
  for (const [i, uci] of moves.entries()) {
    const move = parseStdUci(pos, uci);
    if (!move) throw validationError(`play: illegal move ${uci.slice(0, 10)} at index ${i}`);
    pos.play(move);
  }
  return { fen: fen === undefined || fen.trim() === '' ? null : normalizeFen(fen), play: moves };
}

/** Validates a variant `fen` (+ `play` syntax, and legality when chessops knows the rules). */
export function checkVariantLine(variant: string, fen: string | undefined, play: string | undefined): { fen: string | null; play: string[] } {
  const rules = LICHESS_VARIANTS[variant];
  if (rules === undefined) throw validationError(`variant: unknown variant ${variant}`);
  if (rules === 'chess' && variant !== 'chess960') return checkStandardLine(fen, play);
  const moves = csv(play);
  if (moves.length > MAX_PLAY_MOVES) throw validationError(`play: at most ${MAX_PLAY_MOVES} moves`);
  if (fen === undefined || fen.trim() === '') {
    for (const m of moves) if (!parseUci(m)) throw validationError(`play: not a UCI move: ${m.slice(0, 10)}`);
    return { fen: null, play: moves };
  }
  const text = normalizeFen(fen);
  if (text.length > MAX_FEN_LENGTH) throw validationError('fen: too long');
  const setup = parseFen(text);
  if (setup.isErr) throw validationError(`fen: invalid FEN (${setup.error.message})`);
  const pos = setupPosition(rules, setup.value);
  if (pos.isErr) throw validationError(`fen: illegal position (${pos.error.message})`);
  for (const [i, m] of moves.entries()) {
    const raw = parseUci(m);
    const move = raw && normalizeMove(pos.value, raw);
    if (!move || !pos.value.isLegal(move)) throw validationError(`play: illegal move ${m.slice(0, 10)} at index ${i}`);
    pos.value.play(move);
  }
  return { fen: text, play: moves };
}

/** Normalised explorer.lichess.org/masters query (fixed key order). */
export function mastersUpstreamQuery(q: z.output<typeof mastersQuerySchema>): URLSearchParams {
  const line = checkStandardLine(q.fen, q.play);
  const p = new URLSearchParams();
  if (line.fen !== null) p.set('fen', line.fen);
  if (q.moves !== undefined) p.set('moves', String(q.moves));
  if (line.play.length) p.set('play', line.play.join(','));
  if (q.since) p.set('since', q.since);
  if (q.topGames !== undefined) p.set('topGames', String(q.topGames));
  if (q.until) p.set('until', q.until);
  return p;
}

/** Normalised explorer.lichess.org/lichess query (fixed key order; speeds and ratings sorted). */
export function lichessUpstreamQuery(q: z.output<typeof lichessQuerySchema>): URLSearchParams {
  const variant = q.variant === undefined || q.variant === 'fromPosition' ? 'standard' : q.variant;
  const line = checkVariantLine(variant, q.fen, q.play);
  const speeds = [...new Set(csv(q.speeds))];
  for (const s of speeds) if (!(LICHESS_SPEEDS as readonly string[]).includes(s)) throw validationError(`speeds: unknown speed ${s.slice(0, 20)}`);
  const ratings = [...new Set(csv(q.ratings))];
  for (const r of ratings) if (!/^\d{1,4}$/.test(r)) throw validationError('ratings: expected rating buckets');
  const p = new URLSearchParams();
  if (line.fen !== null) p.set('fen', line.fen);
  if (q.history) p.set('history', q.history);
  if (q.moves !== undefined) p.set('moves', String(q.moves));
  if (line.play.length) p.set('play', line.play.join(','));
  if (ratings.length) p.set('ratings', ratings.map(Number).sort((a, b) => a - b).join(','));
  if (q.recentGames !== undefined) p.set('recentGames', String(q.recentGames));
  if (q.since) p.set('since', q.since);
  if (speeds.length) p.set('speeds', LICHESS_SPEEDS.filter(s => speeds.includes(s)).join(','));
  if (q.topGames !== undefined) p.set('topGames', String(q.topGames));
  if (q.until) p.set('until', q.until);
  p.set('variant', variant);
  return p;
}

/** Validated tablebase FEN (normalised spaces) for a variant. */
export function tablebaseFen(variant: (typeof TABLEBASE_VARIANTS)[number], fen: string): string {
  const text = normalizeFen(fen);
  if (text.length > MAX_FEN_LENGTH) throw validationError('fen: too long');
  const setup = parseFen(text);
  if (setup.isErr) throw validationError(`fen: invalid FEN (${setup.error.message})`);
  const pieces = setup.value.board.occupied.size();
  if (pieces > TABLEBASE_MAX_PIECES[variant]) throw validationError(`fen: too many pieces for the ${variant} tablebase`);
  return text;
}

/** Validated cloud-eval FEN. */
export function cloudEvalFen(fen: string): string {
  const text = normalizeFen(fen);
  if (text.length > MAX_FEN_LENGTH) throw validationError('fen: too long');
  const setup = parseFen(text);
  if (setup.isErr) throw validationError(`fen: invalid FEN (${setup.error.message})`);
  return text;
}
