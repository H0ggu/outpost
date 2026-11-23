/**
 * Writes stored games back out as PGN (database export, PLAN §5 "export"). The original headers
 * (`games.headers_json`) are kept; the Seven Tag Roster comes first and always matches the stored
 * game (players, result), and well-known tags missing from the original are filled from the row.
 */
import type { EpochMs, GameResult } from '@outpost/shared/api';
import { parseClocks } from '../chess/store.ts';
import { pgnMovetext } from '../stats/pgnWriter.ts';

/** The `games` columns the writer needs. */
export interface PgnGameRow {
  id: number;
  url: string | null;
  white: string;
  black: string;
  white_rating: number | null;
  black_rating: number | null;
  white_title: string | null;
  black_title: string | null;
  white_fide_id: string | null;
  black_fide_id: string | null;
  result: GameResult;
  time_control: string | null;
  event: string | null;
  round: string | null;
  started_at: EpochMs | null;
  ended_at: EpochMs | null;
  moves_san: string;
  eco: string | null;
  opening_name: string | null;
  headers_json: string | null;
  /** `games.clocks`, or null. */
  clocks: string | null;
}

/** Column list for `PgnGameRow` (table alias `g`). */
export const PGN_GAME_COLUMNS = `g.id, g.url, g.white, g.black, g.white_rating, g.black_rating, g.white_title, g.black_title,
  g.white_fide_id, g.black_fide_id, g.result, g.time_control, g.event, g.round, g.started_at, g.ended_at, g.moves_san,
  g.eco, g.opening_name, g.headers_json, g.clocks`;

const ROSTER = ['Event', 'Site', 'Date', 'Round', 'White', 'Black', 'Result'] as const;
const SETUP_TAGS = new Set(['SetUp', 'FEN']);

/** A header value safe inside `"…"`: one line, `\` and `"` escaped. */
export const escapeTagValue = (v: string): string => v.replace(/[\r\n\t]+/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"');

const pgnDate = (t: EpochMs | null): string | null => {
  if (t === null) return null;
  const d = new Date(t);
  return `${d.getUTCFullYear()}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${String(d.getUTCDate()).padStart(2, '0')}`;
};

const storedHeaders = (json: string | null): Record<string, string> => {
  if (!json) return {};
  try {
    const v: unknown = JSON.parse(json);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v)) if (typeof val === 'string' && /^[A-Za-z0-9][A-Za-z0-9_+#=:-]*$/.test(k)) out[k] = val;
    return out;
  } catch {
    return {};
  }
};

/** Movetext with move numbers (and clock comments when stored), wrapped at 80 columns, ending with the result. */
export function movetext(movesSan: string, result: GameResult, clocks: string | null = null): string {
  return pgnMovetext(movesSan, result, parseClocks(clocks));
}

/** One game as PGN text (no trailing blank line). */
export function gameToPgn(row: PgnGameRow): string {
  const stored = storedHeaders(row.headers_json);
  const tags = new Map<string, string>();
  tags.set('Event', stored.Event ?? row.event ?? '?');
  tags.set('Site', stored.Site ?? row.url ?? '?');
  tags.set('Date', stored.Date ?? pgnDate(row.started_at ?? row.ended_at) ?? '????.??.??');
  tags.set('Round', stored.Round ?? row.round ?? '?');
  tags.set('White', row.white);
  tags.set('Black', row.black);
  tags.set('Result', row.result);
  for (const [k, v] of Object.entries(stored)) {
    if ((ROSTER as readonly string[]).includes(k) || SETUP_TAGS.has(k)) continue;
    tags.set(k, v);
  }
  const fill = (k: string, v: string | number | null): void => {
    if (v !== null && v !== '' && !tags.has(k)) tags.set(k, String(v));
  };
  fill('WhiteElo', row.white_rating);
  fill('BlackElo', row.black_rating);
  fill('WhiteTitle', row.white_title);
  fill('BlackTitle', row.black_title);
  fill('WhiteFideId', row.white_fide_id);
  fill('BlackFideId', row.black_fide_id);
  fill('TimeControl', row.time_control);
  fill('ECO', row.eco);
  fill('Opening', row.opening_name);
  const head = [...tags].map(([k, v]) => `[${k} "${escapeTagValue(v)}"]`).join('\n');
  return `${head}\n\n${movetext(row.moves_san, row.result, row.clocks)}`;
}
