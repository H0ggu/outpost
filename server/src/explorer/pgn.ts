/**
 * PGN text of a stored game, for `/api/explorer/masters/pgn/op<id>` when the masters explorer reads
 * the local reference DB (its `topGames` ids are Outpost game ids). Tags follow what
 * explorer.lichess.org/masters/pgn sends (Seven Tag Roster + Elo), plus titles, FIDE ids, ECO,
 * opening and time control when known.
 */
import type { Id } from '@outpost/shared/api';
import type { Db } from '../db/index.ts';

interface PgnGameRow {
  id: Id;
  url: string | null;
  database_id: Id | null;
  white: string;
  black: string;
  white_rating: number | null;
  black_rating: number | null;
  white_title: string | null;
  black_title: string | null;
  white_fide_id: string | null;
  black_fide_id: string | null;
  result: string;
  time_control: string | null;
  event: string | null;
  round: string | null;
  started_at: number | null;
  ended_at: number | null;
  moves_san: string;
  eco: string | null;
  opening_name: string | null;
  headers_json: string | null;
}

/** A stored game with the columns the PGN needs, or undefined. */
export function loadPgnGame(db: Db, id: Id): PgnGameRow | undefined {
  return db.get<PgnGameRow>(
    `SELECT id, url, database_id, white, black, white_rating, black_rating, white_title, black_title,
            white_fide_id, black_fide_id, result, time_control, event, round, started_at, ended_at,
            moves_san, eco, opening_name, headers_json
       FROM games WHERE id = ?`,
    [id],
  );
}

const escapeTag = (v: string): string => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ');

const pgnDate = (t: number | null): string => {
  if (t === null) return '????.??.??';
  const d = new Date(t);
  return `${d.getUTCFullYear()}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${String(d.getUTCDate()).padStart(2, '0')}`;
};

/** Movetext with move numbers, wrapped at 80 columns, ending with the result. */
export function movetext(sanMoves: readonly string[], result: string): string {
  const tokens: string[] = [];
  sanMoves.forEach((san, i) => {
    if (i % 2 === 0) tokens.push(`${i / 2 + 1}.`);
    tokens.push(san);
  });
  tokens.push(result);
  const lines: string[] = [];
  let line = '';
  for (const t of tokens) {
    if (line && line.length + 1 + t.length > 80) {
      lines.push(line);
      line = t;
    } else line = line ? `${line} ${t}` : t;
  }
  if (line) lines.push(line);
  return lines.join('\n');
}

/** PGN of a stored game. */
export function gamePgn(g: PgnGameRow): string {
  let original: Record<string, string> = {};
  try {
    const parsed: unknown = g.headers_json ? JSON.parse(g.headers_json) : {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) original = parsed as Record<string, string>;
  } catch {
    // keep the stored columns only
  }
  const orig = (k: string): string | null => (typeof original[k] === 'string' && original[k].trim() !== '' ? original[k] : null);
  const tags: Array<[string, string | null]> = [
    ['Event', g.event ?? orig('Event') ?? '?'],
    ['Site', orig('Site') ?? g.url ?? '?'],
    ['Date', orig('Date') ?? pgnDate(g.ended_at ?? g.started_at)],
    ['Round', g.round ?? orig('Round') ?? '?'],
    ['White', g.white],
    ['Black', g.black],
    ['Result', g.result],
    ['WhiteElo', g.white_rating !== null ? String(g.white_rating) : null],
    ['BlackElo', g.black_rating !== null ? String(g.black_rating) : null],
    ['WhiteTitle', g.white_title],
    ['BlackTitle', g.black_title],
    ['WhiteFideId', g.white_fide_id],
    ['BlackFideId', g.black_fide_id],
    ['TimeControl', g.time_control],
    ['ECO', g.eco],
    ['Opening', g.opening_name],
  ];
  const header = tags
    .filter((t): t is [string, string] => t[1] !== null)
    .map(([k, v]) => `[${k} "${escapeTag(v)}"]`)
    .join('\n');
  const moves = g.moves_san.trim() === '' ? [] : g.moves_san.trim().split(/\s+/);
  return `${header}\n\n${movetext(moves, g.result)}\n`;
}
