/**
 * The openings table (`GET /api/profiles/:slug/openings`, PLAN §5 "Openings").
 *
 * A game's opening is its classification (`games.eco` / `opening_name`: the deepest named
 * position among plies 1…40, by position, so transpositions count). Rows group games by
 * (player colour, ECO, name). A name can have several book positions (the Caro-Kann Exchange has
 * four), and games may reach one of them by transposition without passing through the others, so
 * `line` (what the click-through opens in the explorer and the `line` filter selects) is the book
 * line of the named position most of the row's games reached: the entry of that name whose line is
 * as long as their classification ply (`games.opening_ply`, in the covering index, so no position
 * lookups); when the book has several such entries (68 name and length pairs), the position the
 * games stood in at that ply (a second, narrow query); the exact position when a `maxMoves` bound
 * re-classified the game; the shortest line of the name only when no entry fits.
 *
 * Move bounds (full moves, 1–5 in the UI):
 * - `maxMoves = M` classifies at most M moves deep: the deepest named position within the first
 *   2·M plies. Games whose stored classification is deeper are re-classified from `positions`.
 * - `minMoves = N` drops rows whose line is shorter than N moves (fewer than 2·N − 1 plies).
 * Games without any named position are left out.
 *
 * Order: `most` (games), `best` / `worst` (score, then games). Best and worst only rank rows with
 * at least `OPENINGS_RANK_MIN_GAMES` games (the contract's constant; or `minGames` when higher), so
 * one lucky game does not top the table.
 */
import { OPENINGS_RANK_MIN_GAMES, type Color, type OpeningRow, type OpeningsParams, type OpeningsResponse } from '@outpost/shared/api';
import { colorFromChar, type ColorChar } from '@outpost/shared/chess';
import { getOpeningBook, type OpeningBook, type OpeningEntry } from '../chess/openings.ts';
import { posKey } from '../chess/posKey.ts';
import { GAMES_STATS_INDEX, PLAYER_GAMES_BY_PK, round, scopeWhere, scoreOf, wdlColumns, type StatsScope } from './common.ts';

/** Most rows returned per side. */
export const OPENINGS_MAX_ROWS = 500;
/** Deepest `minMoves` / `maxMoves` (classification looks at 40 plies). */
export const OPENINGS_MAX_MOVES = 20;

/** Book lookups the openings table needs, derived once per book. */
interface BookIndex {
  /** Named positions by `positions.pos_key`. */
  byKey: Map<number, OpeningEntry>;
  /** Shortest line per `eco \t name`. */
  canonical: Map<string, OpeningEntry>;
  /** The entry per `eco \t name \t line length`, when the book has exactly one. */
  byNamePly: Map<string, OpeningEntry>;
  /** `eco \t name \t line length` of several entries (the position decides), as a JSON array for `json_each`. */
  ambiguous: Set<string>;
  ambiguousJson: string;
  /** JSON array of every named `pos_key` (bound to `json_each`). */
  keysJson: string;
}

const indexes = new WeakMap<OpeningBook, BookIndex>();

const nameKey = (eco: string, name: string): string => `${eco}\t${name}`;

/** The book index for the openings table (cached per book). */
export function bookIndex(book: OpeningBook): BookIndex {
  let idx = indexes.get(book);
  if (idx) return idx;
  const byKey = new Map<number, OpeningEntry>();
  const canonical = new Map<string, OpeningEntry>();
  const byNamePly = new Map<string, OpeningEntry>();
  const ambiguous = new Set<string>();
  for (const [epd, entry] of book.byEpd) {
    byKey.set(posKey(epd), entry);
    const k = nameKey(entry.eco, entry.name);
    const prev = canonical.get(k);
    if (!prev || entry.line.length < prev.line.length) canonical.set(k, entry);
    const kp = `${k}\t${entry.line.length}`;
    if (!byNamePly.has(kp) && !ambiguous.has(kp)) byNamePly.set(kp, entry);
    else if (byNamePly.get(kp) !== entry) {
      byNamePly.delete(kp);
      ambiguous.add(kp);
    }
  }
  idx = { byKey, canonical, byNamePly, ambiguous, ambiguousJson: JSON.stringify([...ambiguous]), keysJson: JSON.stringify([...byKey.keys()]) };
  indexes.set(book, idx);
  return idx;
}

/** Parsed endpoint params with defaults applied. */
export interface OpeningsOptions {
  side: NonNullable<OpeningsParams['side']>;
  order: NonNullable<OpeningsParams['order']>;
  minGames?: number | undefined;
  minMoves?: number | undefined;
  maxMoves?: number | undefined;
  /** Rows per side (default `OPENINGS_MAX_ROWS`). */
  limit?: number;
}

interface GroupRow {
  color: ColorChar;
  eco: string | null;
  name: string | null;
  /** Classification ply of games classified within the bound. */
  ply: number | null;
  k: number | null;
  games: number;
  w: number;
  d: number;
  l: number;
  plies: number;
}

interface Acc {
  color: Color;
  /** Games per book entry they reached (the row's line is the most played one). */
  entries: Map<OpeningEntry, number>;
  eco: string;
  name: string;
  games: number;
  w: number;
  d: number;
  l: number;
  plies: number;
}

/** Opening rows of a scope (see the module comment). */
export function openingsStats(scope: StatsScope, opts: OpeningsOptions, book: OpeningBook = getOpeningBook()): OpeningsResponse {
  const idx = bookIndex(book);
  const where = scopeWhere(scope);
  const sideSql = opts.side === 'white' ? " AND pg.color = 'w'" : opts.side === 'black' ? " AND pg.color = 'b'" : '';
  const maxPly = opts.maxMoves !== undefined ? 2 * opts.maxMoves : null;

  let rows: GroupRow[];
  if (maxPly === null || maxPly >= 40) {
    rows = scope.db.all<GroupRow>(
      `SELECT pg.color AS color, g.eco AS eco, g.opening_name AS name, g.opening_ply AS ply, NULL AS k, COUNT(*) AS games,
              ${wdlColumns()}, SUM(g.ply_count) AS plies
         FROM ${PLAYER_GAMES_BY_PK} JOIN ${GAMES_STATS_INDEX} ON g.id = pg.game_id
        WHERE ${where.sql}${sideSql} AND g.opening_ply IS NOT NULL
        GROUP BY 1, 2, 3, 4`,
      where.params,
    );
  } else {
    // Games classified deeper than the bound: the deepest named position within it.
    rows = scope.db.all<GroupRow>(
      `SELECT pg.color AS color,
              CASE WHEN g.opening_ply <= ? THEN g.eco END AS eco,
              CASE WHEN g.opening_ply <= ? THEN g.opening_name END AS name,
              CASE WHEN g.opening_ply <= ? THEN g.opening_ply END AS ply,
              CASE WHEN g.opening_ply > ? THEN (
                SELECT p.pos_key FROM positions p
                 WHERE p.game_id = pg.game_id AND p.ply BETWEEN 1 AND ? AND p.pos_key IN (SELECT value FROM json_each(?))
                 ORDER BY p.ply DESC LIMIT 1) END AS k,
              COUNT(*) AS games, ${wdlColumns()}, SUM(g.ply_count) AS plies
         FROM ${PLAYER_GAMES_BY_PK} JOIN ${GAMES_STATS_INDEX} ON g.id = pg.game_id
        WHERE ${where.sql}${sideSql} AND g.opening_ply IS NOT NULL
        GROUP BY 1, 2, 3, 4, 5`,
      [maxPly, maxPly, maxPly, maxPly, maxPly, idx.keysJson, ...where.params],
    );
  }

  // Games whose name and classification ply match several book entries: the position decides.
  const plyKey = (eco: string, name: string, ply: number): string => `${nameKey(eco, name)}\t${ply}`;
  const exact = new Map<string, Map<OpeningEntry, number>>();
  if (rows.some(r => r.k === null && r.eco !== null && r.name !== null && r.ply !== null && idx.ambiguous.has(plyKey(r.eco, r.name, r.ply)))) {
    const bound = maxPly !== null && maxPly < 40 ? ' AND g.opening_ply <= ?' : '';
    for (const r of scope.db.all<{ color: ColorChar; eco: string; name: string; ply: number; k: number | null; games: number }>(
      `SELECT pg.color AS color, g.eco AS eco, g.opening_name AS name, g.opening_ply AS ply,
              (SELECT p.pos_key FROM positions p WHERE p.game_id = pg.game_id AND p.ply = g.opening_ply) AS k, COUNT(*) AS games
         FROM ${PLAYER_GAMES_BY_PK} JOIN ${GAMES_STATS_INDEX} ON g.id = pg.game_id
        WHERE ${where.sql}${sideSql} AND g.opening_ply IS NOT NULL${bound}
          AND (g.eco || char(9) || g.opening_name || char(9) || g.opening_ply) IN (SELECT value FROM json_each(?))
        GROUP BY 1, 2, 3, 4, 5`,
      [...where.params, ...(bound ? [maxPly!] : []), idx.ambiguousJson],
    )) {
      const entry = r.k !== null ? idx.byKey.get(r.k) : undefined;
      if (!entry) continue;
      const key = `${r.color}\t${plyKey(r.eco, r.name, r.ply)}`;
      let votes = exact.get(key);
      if (!votes) exact.set(key, (votes = new Map()));
      votes.set(entry, (votes.get(entry) ?? 0) + r.games);
    }
  }

  const groups = new Map<string, Acc>();
  for (const r of rows) {
    let eco = r.eco;
    let name = r.name;
    let entry: OpeningEntry | undefined;
    if (r.k !== null) {
      entry = idx.byKey.get(r.k);
      if (!entry) continue;
      eco = entry.eco;
      name = entry.name;
    }
    if (eco === null || name === null) continue; // re-classified with nothing named in range
    const color = colorFromChar(r.color);
    const key = `${color}\t${nameKey(eco, name)}`;
    let acc = groups.get(key);
    if (!acc) {
      acc = { color, entries: new Map(), eco, name, games: 0, w: 0, d: 0, l: 0, plies: 0 };
      groups.set(key, acc);
    }
    const votes = entry === undefined && r.ply !== null ? exact.get(`${r.color}\t${plyKey(eco, name, r.ply)}`) : undefined;
    if (votes) {
      for (const [e, n] of votes) acc.entries.set(e, (acc.entries.get(e) ?? 0) + n);
      exact.delete(`${r.color}\t${plyKey(eco, name, r.ply!)}`); // counted once (rows may repeat a key)
    } else {
      entry ??= (r.ply !== null ? idx.byNamePly.get(plyKey(eco, name, r.ply)) : undefined) ?? idx.canonical.get(nameKey(eco, name));
      if (entry) acc.entries.set(entry, (acc.entries.get(entry) ?? 0) + r.games);
    }
    acc.games += r.games;
    acc.w += r.w;
    acc.d += r.d;
    acc.l += r.l;
    acc.plies += r.plies;
  }

  const minPlies = opts.minMoves !== undefined ? 2 * opts.minMoves - 1 : 0;
  const minGames = Math.max(opts.minGames ?? 1, opts.order === 'most' ? 1 : OPENINGS_RANK_MIN_GAMES);
  const out: OpeningsResponse = { white: [], black: [] };
  for (const a of groups.values()) {
    if (a.games < minGames) continue;
    // The entry most of the row's games reached (ties: the shorter line).
    let entry: OpeningEntry | null = null;
    let most = 0;
    for (const [e, n] of a.entries) {
      if (n > most || (n === most && entry !== null && e.line.length < entry.line.length)) {
        entry = e;
        most = n;
      }
    }
    if (minPlies > 0 && (entry?.line.length ?? 0) < minPlies) continue;
    const row: OpeningRow = {
      eco: a.eco,
      name: a.name,
      line: entry?.line.join(',') ?? '',
      color: a.color,
      games: a.games,
      w: a.w,
      d: a.d,
      l: a.l,
      avgPly: round(a.plies / a.games, 1),
    };
    out[a.color].push(row);
  }

  const score = (r: OpeningRow): number => scoreOf(r.games, r.w, r.d) ?? 0;
  const byName = (a: OpeningRow, b: OpeningRow): number => a.eco.localeCompare(b.eco) || a.name.localeCompare(b.name);
  const cmp =
    opts.order === 'best'
      ? (a: OpeningRow, b: OpeningRow) => score(b) - score(a) || b.games - a.games || byName(a, b)
      : opts.order === 'worst'
        ? (a: OpeningRow, b: OpeningRow) => score(a) - score(b) || b.games - a.games || byName(a, b)
        : (a: OpeningRow, b: OpeningRow) => b.games - a.games || byName(a, b);
  const limit = opts.limit ?? OPENINGS_MAX_ROWS;
  for (const c of ['white', 'black'] as const) out[c] = out[c].sort(cmp).slice(0, limit);
  return out;
}
