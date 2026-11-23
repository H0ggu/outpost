/**
 * Stored game → PGN text, for `GET /api/games/:id` and the bulk export
 * (`GET /api/profiles/:slug/games.pgn`, PLAN §5 "PGN bulk export").
 *
 * Tags: the Seven Tag Roster first, then Outpost's own facts (UTC date/time, ratings, titles,
 * FIDE ids, time control, ECO, opening, termination), then any other original header of an
 * imported PGN in its original order. Stored columns win over original headers for the tags
 * Outpost keeps in columns, so an exported game re-imports to the same row. Movetext is the
 * stored mainline with move numbers, wrapped at 80 columns.
 */
import type { EpochMs, GameOrigin, GameResult, Id, Termination, TimeClass } from '@outpost/shared/api';

/** Columns of `games g` needed by `gameToPgn`. */
export const PGN_GAME_COLUMNS = `g.id, g.origin, g.url, g.white, g.black, g.white_rating, g.black_rating, g.white_title,
  g.black_title, g.white_fide_id, g.black_fide_id, g.result, g.termination, g.time_class, g.time_control, g.rated, g.event,
  g.round, g.started_at, g.ended_at, g.moves_san, g.eco, g.opening_name, g.headers_json`;

/** A row of `SELECT ${PGN_GAME_COLUMNS} FROM games g`. */
export interface PgnGameRecord {
  id: Id;
  origin: GameOrigin;
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
  termination: Termination;
  time_class: TimeClass;
  time_control: string | null;
  rated: number;
  event: string | null;
  round: string | null;
  started_at: EpochMs | null;
  ended_at: EpochMs | null;
  moves_san: string;
  eco: string | null;
  opening_name: string | null;
  headers_json: string | null;
}

/** Options of `gameToPgn`. */
export interface PgnWriteOptions {
  /** Replacement player names (the bulk export writes the profile name for the profile's side). */
  names?: { white?: string; black?: string };
}

/** PGN `Termination` tag value for a stored termination (lichess's vocabulary). */
export function terminationTag(t: Termination): string | null {
  switch (t) {
    case 'timeout':
    case 'timeout_vs_insufficient':
      return 'Time forfeit';
    case 'abandon':
      return 'Abandoned';
    case 'other':
      return null;
    default:
      return 'Normal';
  }
}

/** Original headers from `headers_json` (string values only), or an empty map. */
export function parseHeaders(json: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!json) return out;
  try {
    const v: unknown = JSON.parse(json);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (typeof val === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(k)) out.set(k, val);
      }
    }
  } catch {
    // corrupt JSON: no original headers
  }
  return out;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');
const pgnDate = (t: number): string => {
  const d = new Date(t);
  return `${String(d.getUTCFullYear()).padStart(4, '0')}.${pad2(d.getUTCMonth() + 1)}.${pad2(d.getUTCDate())}`;
};
const pgnTime = (t: number): string => {
  const d = new Date(t);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
};

/** Escapes a tag value (PGN spec §8.1.1: `\` and `"` are escaped; no line breaks). */
const escapeTag = (v: string): string =>
  v
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');

const titleCase = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** Tag pairs in output order. */
export function pgnTags(r: PgnGameRecord, opts: PgnWriteOptions = {}): Array<[string, string]> {
  const original = parseHeaders(r.headers_json);
  const online = r.origin === 'lichess' || r.origin === 'chesscom';
  const at = r.started_at ?? r.ended_at;
  const tags = new Map<string, string>();
  const set = (k: string, v: string | number | null | undefined): void => {
    if (v !== null && v !== undefined && v !== '') tags.set(k, String(v));
  };

  // Seven Tag Roster.
  set(
    'Event',
    r.event ?? original.get('Event') ?? (online ? `${r.rated ? 'Rated' : 'Casual'} ${titleCase(r.time_class)} game` : '?'),
  );
  set(
    'Site',
    r.url ?? original.get('Site') ?? (r.origin === 'lichess' ? 'https://lichess.org' : r.origin === 'chesscom' ? 'https://www.chess.com' : '?'),
  );
  set('Date', online || !original.has('Date') ? (at !== null ? pgnDate(at) : '????.??.??') : original.get('Date'));
  set('Round', r.round ?? original.get('Round') ?? '-');
  set('White', opts.names?.white ?? r.white);
  set('Black', opts.names?.black ?? r.black);
  set('Result', r.result);

  // Outpost's own facts.
  if (at !== null && (online || original.has('UTCDate'))) {
    set('UTCDate', pgnDate(at));
    set('UTCTime', pgnTime(at));
  }
  set('WhiteElo', r.white_rating);
  set('BlackElo', r.black_rating);
  set('WhiteTitle', r.white_title);
  set('BlackTitle', r.black_title);
  set('WhiteFideId', r.white_fide_id);
  set('BlackFideId', r.black_fide_id);
  set('TimeControl', r.time_control);
  set('ECO', r.eco);
  set('Opening', r.opening_name);
  if (!original.has('Termination')) set('Termination', terminationTag(r.termination));

  // The rest of the original headers, in their order (never a set-up position: Outpost stores
  // standard games from the start only).
  for (const [k, v] of original) {
    if (tags.has(k) || k === 'FEN' || k === 'SetUp') continue;
    if ((k === 'WhiteElo' || k === 'BlackElo') && !/^\d+$/.test(v)) continue;
    set(k, v);
  }
  return [...tags];
}

/** Mainline movetext with move numbers and the result, wrapped at 80 columns. */
export function pgnMovetext(movesSan: string, result: string): string {
  const sans = movesSan.split(' ').filter(s => s !== '');
  const tokens: string[] = [];
  for (const [i, san] of sans.entries()) tokens.push(i % 2 === 0 ? `${i / 2 + 1}. ${san}` : san);
  tokens.push(result);
  const lines: string[] = [];
  let line = '';
  for (const tok of tokens) {
    if (line && line.length + 1 + tok.length > 80) {
      lines.push(line);
      line = tok;
    } else line = line ? `${line} ${tok}` : tok;
  }
  if (line) lines.push(line);
  return lines.join('\n');
}

/** One game as PGN text (tags, blank line, movetext, trailing newline). */
export function gameToPgn(r: PgnGameRecord, opts: PgnWriteOptions = {}): string {
  const tags = pgnTags(r, opts)
    .map(([k, v]) => `[${k} "${escapeTag(v)}"]`)
    .join('\n');
  return `${tags}\n\n${pgnMovetext(r.moves_san, r.result)}\n`;
}
