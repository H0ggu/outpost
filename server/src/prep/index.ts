/**
 * Tournament preparation (PLAN §5 "Tournament preparation", §6 prep endpoints, §4 prep_sets /
 * prep_opponents): named lists of opponent profiles, and a printable report card per opponent.
 *
 * Prep sets are private to their owner (404 for everyone else, admins included). Opponents are
 * profiles the owner may see (`loadProfileForViewer` rules); one that later becomes invisible
 * (made private by its owner, deleted) silently drops out of the set and its report.
 *
 * Report, per opponent, over the games the shared filters select (`playerGamesWhere`):
 * - as White / as Black: games, W/D/L, the most played lines (`plies` long) and the worst-scoring
 *   lines (any length from 2 plies, at least `minGames` games; a line is shown at its longest
 *   form when every game of it continued the same way);
 * - the 10 most recent games (`GAME_ROW_SELECT` / `toGameRow`);
 * - activity by hour and weekday in `tz`;
 * - current ratings per visible source.
 * All scores are from the opponent's side. Games and W/D/L count every selected game; the lines
 * and the activity come from the `PREP_MAX_GAMES` most recent ones (`sampledGames` says when
 * that is fewer than all), so a report over opponents with huge histories stays quick. The report
 * yields to the event loop between opponents.
 */
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import { Chess } from 'chessops/chess';
import { makeSanAndPlay, parseSan } from 'chessops/san';
import type {
  ActivityCell,
  CreatePrepRequest,
  EpochMs,
  Id,
  PrepLine,
  PrepOpponentReport,
  PrepReport,
  PrepSet,
  PrepSide,
  ProfileFilters,
  UpdatePrepRequest,
} from '@outpost/shared/api';
import { epdOf, scoreRate, stdUci, type ColorChar, type Outcome, type Wdl } from '@outpost/shared/chess';
import { z } from 'zod';
import { classifyOpening, getOpeningBook, type OpeningBook } from '../chess/openings.ts';
import type { Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import { HttpError, notFound, validationError } from '../http/errors.ts';
import type { AuthUser } from '../http/types.ts';
import { loadProfileByIdForViewer, type ViewableProfile } from '../profiles/access.ts';
import { profileSummaries } from '../profiles/service.ts';
import { currentRatings, SOURCE_COLUMNS, type SourceRow } from '../profiles/sources.ts';
import { GAME_ROW_SELECT, playerGamesWhere, toGameRow, type GameRowRecord } from '../stats/index.ts';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** Most opponents in one prep set. */
export const MAX_PREP_OPPONENTS = 50;
/** Most prep sets per user. */
export const MAX_PREP_SETS = 500;

const nameSchema = z
  .string()
  .trim()
  .min(1, 'enter a name')
  .max(100)
  .refine(s => !/[\u0000-\u001f\u007f]/.test(s), 'control characters are not allowed');
const profileIdsSchema = z.array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)).max(MAX_PREP_OPPONENTS);

/** `CreatePrepRequest`. */
export const createPrepSchema = z.object({ name: nameSchema, profileIds: profileIdsSchema });
/** `UpdatePrepRequest`. */
export const updatePrepSchema = z.object({ name: nameSchema.optional(), profileIds: profileIdsSchema.optional() });

const isTimeZone = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/** `PrepReportParams` (the filters are parsed separately with `parseFiltersQuery`). */
export const prepReportParamsSchema = z.object({
  tz: z.string().max(64).refine(isTimeZone, 'not an IANA time zone').default('UTC'),
  plies: z.coerce.number().int().min(2).max(20).default(8),
  minGames: z.coerce.number().int().min(1).max(100).default(3),
});

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

interface PrepRow {
  id: Id;
  name: string;
  created_at: EpochMs;
  updated_at: EpochMs;
}

const ownPrep = (db: Db, viewer: AuthUser, id: Id): PrepRow => {
  const row = db.get<PrepRow>('SELECT id, name, created_at, updated_at FROM prep_sets WHERE id = ? AND owner_user_id = ?', [id, viewer.id]);
  if (!row) throw notFound('Prep not found');
  return row;
};

const opponentIds = (db: Db, prepId: Id): Id[] =>
  db.all<{ profile_id: Id }>('SELECT profile_id FROM prep_opponents WHERE prep_id = ? ORDER BY position, profile_id', [prepId]).map(r => r.profile_id);

function toPrepSet(db: Db, viewer: AuthUser, row: PrepRow): PrepSet {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    opponents: profileSummaries(db, opponentIds(db, row.id), viewer),
  };
}

/** Distinct ids, in order, each a profile the viewer may see (400 otherwise). */
function checkOpponents(db: Db, viewer: AuthUser, ids: readonly Id[]): Id[] {
  const unique = [...new Set(ids)];
  const missing: Id[] = [];
  for (const id of unique) {
    try {
      loadProfileByIdForViewer(db, id, viewer);
    } catch (e) {
      if (e instanceof HttpError && e.statusCode === 404) missing.push(id);
      else throw e;
    }
  }
  if (missing.length) {
    throw validationError(`Unknown profile${missing.length > 1 ? 's' : ''} ${missing.join(', ')}`, {
      issues: [{ path: 'profileIds', message: `not found: ${missing.join(', ')}` }],
    });
  }
  return unique;
}

const setOpponents = (db: Db, prepId: Id, ids: readonly Id[]): void => {
  db.run('DELETE FROM prep_opponents WHERE prep_id = ?', [prepId]);
  for (const [position, id] of ids.entries()) {
    db.run('INSERT INTO prep_opponents (prep_id, profile_id, position) VALUES (?, ?, ?)', [prepId, id, position]);
  }
};

/** `GET /api/prep`: my prep sets, most recently changed first. */
export function listPrep(db: Db, viewer: AuthUser): PrepSet[] {
  return db
    .all<PrepRow>('SELECT id, name, created_at, updated_at FROM prep_sets WHERE owner_user_id = ? ORDER BY updated_at DESC, id DESC', [viewer.id])
    .map(r => toPrepSet(db, viewer, r));
}

/** `GET /api/prep/:id`. */
export function getPrep(db: Db, viewer: AuthUser, id: Id): PrepSet {
  return toPrepSet(db, viewer, ownPrep(db, viewer, id));
}

/** `POST /api/prep`. */
export function createPrep(db: Db, viewer: AuthUser, body: CreatePrepRequest): PrepSet {
  const ids = checkOpponents(db, viewer, body.profileIds);
  const count = db.value<number>('SELECT COUNT(*) FROM prep_sets WHERE owner_user_id = ?', [viewer.id]) ?? 0;
  if (count >= MAX_PREP_SETS) throw new HttpError(403, 'forbidden', `You can keep at most ${MAX_PREP_SETS} prep sets`);
  const id = db.tx(() => {
    const now = Date.now();
    const prepId = db.run('INSERT INTO prep_sets (owner_user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)', [
      viewer.id,
      body.name,
      now,
      now,
    ]).lastInsertRowid;
    setOpponents(db, prepId, ids);
    return prepId;
  });
  return getPrep(db, viewer, id);
}

/** `PUT /api/prep/:id`: rename and/or replace the opponents. */
export function updatePrep(db: Db, viewer: AuthUser, id: Id, patch: UpdatePrepRequest): PrepSet {
  const row = ownPrep(db, viewer, id);
  const ids = patch.profileIds !== undefined ? checkOpponents(db, viewer, patch.profileIds) : null;
  db.tx(() => {
    db.run('UPDATE prep_sets SET name = ?, updated_at = ? WHERE id = ?', [patch.name ?? row.name, Math.max(Date.now(), row.updated_at + 1), id]);
    if (ids) setOpponents(db, id, ids);
  });
  return getPrep(db, viewer, id);
}

/** `DELETE /api/prep/:id`. */
export function deletePrep(db: Db, viewer: AuthUser, id: Id): void {
  ownPrep(db, viewer, id);
  db.run('DELETE FROM prep_sets WHERE id = ?', [id]);
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/** Lines shown per side. */
export const TOP_LINES = 10;
export const WORST_LINES = 5;
/** Recent games per opponent. */
export const RECENT_GAMES = 10;
/** Most recent games per opponent the lines and the activity are computed from. */
export const PREP_MAX_GAMES = 5000;

/** Report options. */
export interface PrepReportOptions {
  tz: string;
  plies: number;
  minGames: number;
  /** Clock for `period` filters (tests pin it). */
  now?: number;
  /** Games per opponent for lines and activity (default `PREP_MAX_GAMES`; tests lower it). */
  maxGames?: number;
}

interface LineAcc extends Wdl {
  sans: string[];
  lastPlayed: EpochMs | null;
}

/** Longest SAN token (`Qa1xb2#`, `exd8=Q+`) plus the separating space. */
const SAN_SLOT = 8;

/** SAN line → UCI line, numbered SAN and the opening it reaches (null when a move is illegal). */
function describeLine(book: OpeningBook, sans: readonly string[]): { uci: string[]; san: string; eco: string | null; name: string | null } | null {
  const pos = Chess.default();
  const epds = [epdOf(pos)];
  const uci: string[] = [];
  const parts: string[] = [];
  for (const [i, s] of sans.entries()) {
    const move = parseSan(pos, s);
    if (!move) return null;
    uci.push(stdUci(pos, move));
    const san = makeSanAndPlay(pos, move);
    parts.push(i % 2 === 0 ? `${i / 2 + 1}. ${san}` : san);
    epds.push(epdOf(pos));
  }
  const opening = classifyOpening(book, epds);
  return { uci, san: parts.join(' '), eco: opening?.eco ?? null, name: opening?.name ?? null };
}

function toPrepLine(book: OpeningBook, acc: LineAcc): PrepLine | null {
  const d = describeLine(book, acc.sans);
  if (!d) return null;
  const games = acc.w + acc.d + acc.l;
  return {
    line: d.uci.join(','),
    san: d.san,
    eco: d.eco,
    name: d.name,
    games,
    w: acc.w,
    d: acc.d,
    l: acc.l,
    score: scoreRate(acc),
    lastPlayed: acc.lastPlayed,
  };
}

const total = (x: Wdl): number => x.w + x.d + x.l;

/** One side of the repertoire from the games' opening moves. */
export function buildSide(
  book: OpeningBook,
  games: ReadonlyArray<{ outcome: Outcome; at: EpochMs | null; sans: readonly string[] }>,
  opts: { plies: number; minGames: number },
): PrepSide {
  const wdl: Wdl = { w: 0, d: 0, l: 0 };
  // Every prefix of every game (for the worst lines), and each game once under its first `plies`
  // moves (the top lines; shorter games under their whole line).
  const lines = new Map<string, LineAcc>();
  const leaves = new Map<string, LineAcc>();
  const count = (map: Map<string, LineAcc>, sans: string[], g: (typeof games)[number]): void => {
    const key = sans.join(' ');
    let acc = map.get(key);
    if (!acc) {
      acc = { sans, w: 0, d: 0, l: 0, lastPlayed: null };
      map.set(key, acc);
    }
    acc[g.outcome]++;
    if (g.at !== null && (acc.lastPlayed === null || g.at > acc.lastPlayed)) acc.lastPlayed = g.at;
  };
  for (const g of games) {
    wdl[g.outcome]++;
    const sans = g.sans.slice(0, opts.plies);
    if (sans.length === 0) continue;
    for (let depth = 1; depth <= sans.length; depth++) count(lines, sans.slice(0, depth), g);
    count(leaves, sans, g);
  }
  const byRecency = (a: LineAcc, b: LineAcc): number => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0);
  const top = [...leaves.values()].sort((a, b) => total(b) - total(a) || byRecency(a, b)).slice(0, TOP_LINES);

  // A line whose games all continued with the same move is shown at its longest form.
  const childCount = new Map<string, number>();
  for (const acc of lines.values()) {
    if (acc.sans.length < 2) continue;
    const parent = acc.sans.slice(0, -1).join(' ');
    childCount.set(parent, Math.max(childCount.get(parent) ?? 0, total(acc)));
  }
  const worst = [...lines.entries()]
    .filter(([key, acc]) => acc.sans.length >= 2 && total(acc) >= opts.minGames && childCount.get(key) !== total(acc))
    .map(([, acc]) => acc)
    .sort((a, b) => (scoreRate(a) ?? 0) - (scoreRate(b) ?? 0) || total(b) - total(a) || b.sans.length - a.sans.length)
    .slice(0, WORST_LINES);

  return {
    games: total(wdl),
    wdl,
    topLines: top.map(a => toPrepLine(book, a)).filter((l): l is PrepLine => l !== null),
    worstLines: worst.map(a => toPrepLine(book, a)).filter((l): l is PrepLine => l !== null),
  };
}

const emptyCell = (): ActivityCell => ({ games: 0, score: null });
const WEEKDAYS: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

/** Games and score by local hour and weekday (Monday = 0) in `tz`. */
export function activityBuckets(
  games: ReadonlyArray<{ outcome: Outcome; at: EpochMs | null }>,
  tz: string,
): { byHour: ActivityCell[]; byWeekday: ActivityCell[] } {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', hour: '2-digit', weekday: 'short' });
  const hours = Array.from({ length: 24 }, () => ({ games: 0, points: 0 }));
  const days = Array.from({ length: 7 }, () => ({ games: 0, points: 0 }));
  for (const g of games) {
    if (g.at === null) continue;
    let hour = 0;
    let day = 0;
    for (const p of fmt.formatToParts(g.at)) {
      if (p.type === 'hour') hour = Number(p.value) % 24;
      else if (p.type === 'weekday') day = WEEKDAYS[p.value] ?? 0;
    }
    const pts = g.outcome === 'w' ? 1 : g.outcome === 'd' ? 0.5 : 0;
    hours[hour]!.games++;
    hours[hour]!.points += pts;
    days[day]!.games++;
    days[day]!.points += pts;
  }
  const cell = (b: { games: number; points: number }): ActivityCell => (b.games ? { games: b.games, score: b.points / b.games } : emptyCell());
  return { byHour: hours.map(cell), byWeekday: days.map(cell) };
}

/** The report card of one opponent. */
export function opponentReport(
  db: Db,
  book: OpeningBook,
  profile: ViewableProfile,
  viewer: AuthUser,
  filters: ProfileFilters,
  opts: PrepReportOptions,
): PrepOpponentReport | null {
  const summary = profileSummaries(db, [profile.id], viewer)[0];
  if (!summary) return null;
  const where = playerGamesWhere(filters, { sourceIds: profile.sourceIds, ...(opts.now !== undefined ? { now: opts.now } : {}) });

  // Totals over every selected game; lines and activity over the most recent ones.
  const totals = { w: { w: 0, d: 0, l: 0 }, b: { w: 0, d: 0, l: 0 } } satisfies Record<ColorChar, Wdl>;
  for (const r of db.all<{ color: ColorChar; outcome: Outcome; n: number }>(
    `SELECT pg.color, pg.outcome, COUNT(*) AS n FROM player_games pg JOIN games g ON g.id = pg.game_id
      WHERE ${where.sql} GROUP BY pg.color, pg.outcome`,
    where.params,
  )) {
    totals[r.color][r.outcome] = r.n;
  }
  const maxGames = opts.maxGames ?? PREP_MAX_GAMES;
  const rows = db.all<{ color: ColorChar; outcome: Outcome; at: EpochMs | null; head: string }>(
    `SELECT pg.color, pg.outcome, COALESCE(g.started_at, pg.ended_at) AS at, substr(g.moves_san, 1, ?) AS head
       FROM player_games pg JOIN games g ON g.id = pg.game_id
      WHERE ${where.sql}
      ORDER BY pg.ended_at DESC, pg.game_id DESC LIMIT ?`,
    [opts.plies * SAN_SLOT, ...where.params, maxGames],
  );
  const all = total(totals.w) + total(totals.b);
  const side = (c: ColorChar): PrepSide => {
    const built = buildSide(
      book,
      rows.filter(r => r.color === c).map(r => ({ outcome: r.outcome, at: r.at, sans: r.head.split(' ').filter(Boolean) })),
      opts,
    );
    return { ...built, games: total(totals[c]), wdl: { ...totals[c] } };
  };

  const recentGames = db
    .all<GameRowRecord>(`${GAME_ROW_SELECT} WHERE ${where.sql} ORDER BY pg.ended_at DESC, pg.game_id DESC LIMIT ?`, [...where.params, RECENT_GAMES])
    .map(toGameRow);

  const sources = profile.sourceIds.length
    ? db.all<SourceRow>(
        `SELECT ${SOURCE_COLUMNS} FROM profile_sources ps JOIN sources s ON s.id = ps.source_id
          WHERE ps.profile_id = ? AND s.id IN (${profile.sourceIds.map(() => '?').join(', ')}) ORDER BY ps.position, s.id`,
        [profile.id, ...profile.sourceIds],
      )
    : [];

  return {
    profile: summary,
    asWhite: side('w'),
    asBlack: side('b'),
    recentGames,
    activity: { tz: opts.tz, ...activityBuckets(rows, opts.tz) },
    ratings: sources.map(s => ({ sourceId: s.id, kind: s.kind, ratings: currentRatings(db, s) })),
    sampledGames: all > rows.length ? rows.length : null,
  };
}

/** `GET /api/prep/:id/report`. Yields to the event loop between opponents. */
export async function prepReport(
  db: Db,
  config: Config,
  viewer: AuthUser,
  id: Id,
  filters: ProfileFilters,
  opts: PrepReportOptions,
): Promise<PrepReport> {
  const row = ownPrep(db, viewer, id);
  const book = getOpeningBook(config.openingsDir);
  const opponents: PrepOpponentReport[] = [];
  for (const [i, profileId] of opponentIds(db, id).entries()) {
    if (i > 0) await yieldToLoop();
    let profile: ViewableProfile;
    try {
      profile = loadProfileByIdForViewer(db, profileId, viewer);
    } catch (e) {
      if (e instanceof HttpError && e.statusCode === 404) continue;
      throw e;
    }
    const report = opponentReport(db, book, profile, viewer, filters, opts);
    if (report) opponents.push(report);
  }
  return { prep: { id: row.id, name: row.name }, generatedAt: Date.now(), opponents };
}
