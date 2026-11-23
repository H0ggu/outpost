/**
 * The one writer of `games`, `positions` and `player_games` (PLAN §4, §7 "After inserting games").
 *
 * Every importer — Lichess and Chess.com sync (jobs), PGN databases (profiles), reference and
 * broadcast imports (reference) — maps its input to a `NormalizedGame` and calls `insertGame`.
 * Attaching a source to games that are already stored (a `pgn` player in a database, a `fide`
 * player in the reference DB) calls `rebuildPlayerGames`. Tests seed data the same way, so the
 * stats and explorer queries always see rows shaped like production ones.
 *
 * Owner: jobs. The signatures are the cross-module contract; the bodies may be optimised.
 */
import { Chess } from 'chessops/chess';
import { makeSanAndPlay, parseSan } from 'chessops/san';
import type { EpochMs, GameOrigin, GameResult, Id, SourceKind, Termination, TimeClass, Title } from '@outpost/shared/api';
import { colorChar, epdOf, outcomeFor, playerKey, stdUci, type Color } from '@outpost/shared/chess';
import type { Db } from '../db/index.ts';
import { classifyOpening, getOpeningBook, type OpeningBook } from './openings.ts';
import { posKey } from './posKey.ts';

/** Positions are stored for plies 0…50 (PLAN §4). */
export const POSITION_MAX_PLY = 50;

/** One side of a game as an importer sees it. */
export interface NormalizedPlayer {
  /** Username (lichess/chesscom) or the PGN name as written. */
  name: string;
  /** Pre-game rating (Chess.com reports post-game ratings: see PLAN §7 for how to derive it). */
  rating: number | null;
  /** Rating after the game when known (Lichess rating + ratingDiff, Chess.com rating). */
  ratingAfter: number | null;
  title: Title | null;
  /** FIDE id (PGN `WhiteFideId`), digits only. */
  fideId: string | null;
  /** 0–100 when the site computed it. */
  accuracy: number | null;
}

/** A finished standard-chess game from the start position, ready to store. */
export interface NormalizedGame {
  origin: GameOrigin;
  /**
   * Lichess game id | Chess.com game uuid | for `pgn`/`reference`: `<databaseId>:<dedupe hash>`
   * (`pgnOriginId`), so `UNIQUE(origin, origin_id)` is the duplicate check (PLAN §5).
   */
  originId: string;
  url: string | null;
  /** Set for `pgn` and `reference` games. */
  databaseId: Id | null;
  white: NormalizedPlayer;
  black: NormalizedPlayer;
  result: GameResult;
  termination: Termination;
  timeClass: TimeClass;
  /** PGN form: `180+2`, `600`, `1/259200`. */
  timeControl: string | null;
  rated: boolean;
  event: string | null;
  round: string | null;
  startedAt: EpochMs | null;
  /** Null only for PGN games without a usable date. */
  endedAt: EpochMs | null;
  /** Mainline SAN from the standard start position (validated and normalised on insert). */
  moves: readonly string[];
  /** Original PGN headers (stored as headers_json), or null. */
  headers: Record<string, string> | null;
}

/** `insertGame` rejected the game (illegal or unparsable move). Importers count it as skipped. */
export class InvalidGameError extends Error {
  override name = 'InvalidGameError';
}

/** Result of `insertGame`. */
export interface InsertGameResult {
  gameId: Id;
  /** False when `(origin, originId)` was already stored (a duplicate); player_games rows are still ensured. */
  inserted: boolean;
  /** Sources that now have a player_games row for this game. */
  sourceIds: Id[];
}

/** `sources.key` of a `pgn` source: `<databaseId>:<playerKey(name)>`. */
export const pgnSourceKey = (databaseId: Id, playerName: string): string => `${databaseId}:${playerKey(playerName)}`;

/** What player_games needs about a game, from a NormalizedGame or a `games` row. */
interface GameFacts {
  origin: GameOrigin;
  databaseId: Id | null;
  result: GameResult;
  endedAt: EpochMs | null;
  timeClass: TimeClass;
  rated: boolean;
  white: SideFacts;
  black: SideFacts;
}
interface SideFacts {
  name: string;
  key: string;
  rating: number | null;
  ratingAfter: number | null;
  title: string | null;
  fideId: string | null;
}

/** Source kind and key under which the opponent is known (world map, opponents tab). */
function opponentIdentity(origin: GameOrigin, opp: SideFacts): { kind: SourceKind; key: string } {
  if (origin === 'lichess' || origin === 'chesscom') return { kind: origin, key: opp.key };
  if (opp.fideId) return { kind: 'fide', key: opp.fideId };
  return { kind: 'pgn', key: opp.key };
}

/** Sources that played this game, with their colour (PLAN §7: one row per source that appears). */
function matchSources(db: Db, g: GameFacts): Array<{ sourceId: Id; color: Color }> {
  const out: Array<{ sourceId: Id; color: Color }> = [];
  const add = (kind: SourceKind, key: string | null, color: Color): void => {
    if (!key) return;
    const id = db.value<Id>('SELECT id FROM sources WHERE kind = ? AND key = ?', [kind, key]);
    if (id !== undefined && !out.some(m => m.sourceId === id)) out.push({ sourceId: id, color });
  };
  for (const color of ['white', 'black'] as const) {
    const side = g[color];
    if (g.origin === 'lichess' || g.origin === 'chesscom') add(g.origin, side.key, color);
    else {
      if (g.databaseId !== null) add('pgn', `${g.databaseId}:${side.key}`, color);
      // FIDE profiles are built from reference-DB games only (PLAN §5), never from users' PGN databases.
      if (g.origin === 'reference') add('fide', side.fideId, color);
    }
  }
  return out;
}

const INSERT_PLAYER_GAME = `INSERT OR IGNORE INTO player_games
  (source_id, game_id, color, outcome, rating, rating_after, opp_name, opp_key, opp_rating, opp_title,
   opp_source_kind, ended_at, time_class, rated)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function writePlayerGame(db: Db, sourceId: Id, gameId: Id, color: Color, g: GameFacts): boolean {
  const me = g[color];
  const opp = g[color === 'white' ? 'black' : 'white'];
  const oppId = opponentIdentity(g.origin, opp);
  const r = db.run(INSERT_PLAYER_GAME, [
    sourceId,
    gameId,
    colorChar(color),
    outcomeFor(g.result, color),
    me.rating,
    me.ratingAfter,
    opp.name,
    oppId.key,
    opp.rating,
    opp.title,
    oppId.kind,
    g.endedAt,
    g.timeClass,
    g.rated,
  ]);
  return r.changes > 0;
}

/**
 * Stores one game: validates and normalises the moves, classifies the opening, writes `games`,
 * `positions` (plies 0…50) and a `player_games` row for every existing source that played it
 * (matched by kind and key: lichess/chesscom username, `pgn` `<dbId>:<name>`, `fide` id).
 * Idempotent: a duplicate returns the stored id with `inserted: false`.
 * Synchronous; call it inside `db.tx()` in batches (e.g. 500 games per transaction).
 * Throws `InvalidGameError` for an illegal move.
 */
export function insertGame(db: Db, game: NormalizedGame, opts: { openings?: OpeningBook } = {}): InsertGameResult {
  const facts: GameFacts = {
    origin: game.origin,
    databaseId: game.databaseId,
    result: game.result,
    endedAt: game.endedAt,
    timeClass: game.timeClass,
    rated: game.rated,
    white: { ...game.white, key: playerKey(game.white.name) },
    black: { ...game.black, key: playerKey(game.black.name) },
  };

  return db.tx(() => {
    let gameId = db.value<Id>('SELECT id FROM games WHERE origin = ? AND origin_id = ?', [game.origin, game.originId]);
    const inserted = gameId === undefined;
    if (gameId === undefined) {
      const pos = Chess.default();
      const epds = [epdOf(pos)];
      const ucis: string[] = [];
      const sans: string[] = [];
      for (const [i, san] of game.moves.entries()) {
        const move = parseSan(pos, san);
        if (!move) throw new InvalidGameError(`Illegal or unparsable move ${JSON.stringify(san)} at ply ${i + 1}`);
        if (i < POSITION_MAX_PLY + 1) ucis.push(stdUci(pos, move));
        sans.push(makeSanAndPlay(pos, move));
        if (i + 1 <= POSITION_MAX_PLY) epds.push(epdOf(pos));
      }
      const opening = classifyOpening(opts.openings ?? getOpeningBook(), epds);

      gameId = db.run(
        `INSERT INTO games (origin, origin_id, url, database_id, white, black, white_key, black_key,
           white_rating, black_rating, white_title, black_title, white_fide_id, black_fide_id, result,
           termination, time_class, time_control, rated, event, round, started_at, ended_at, ply_count,
           moves_san, eco, opening_name, opening_ply, accuracy_white, accuracy_black, headers_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          game.origin,
          game.originId,
          game.url,
          game.databaseId,
          game.white.name,
          game.black.name,
          facts.white.key,
          facts.black.key,
          game.white.rating,
          game.black.rating,
          game.white.title,
          game.black.title,
          game.white.fideId,
          game.black.fideId,
          game.result,
          game.termination,
          game.timeClass,
          game.timeControl,
          game.rated,
          game.event,
          game.round,
          game.startedAt,
          game.endedAt,
          sans.length,
          sans.join(' '),
          opening?.eco ?? null,
          opening?.name ?? null,
          opening?.ply ?? null,
          game.white.accuracy,
          game.black.accuracy,
          game.headers ? JSON.stringify(game.headers) : null,
        ],
      ).lastInsertRowid;

      for (const [ply, epd] of epds.entries()) {
        db.run('INSERT INTO positions (game_id, ply, pos_key, next_uci) VALUES (?, ?, ?, ?)', [
          gameId,
          ply,
          posKey(epd),
          ucis[ply] ?? null,
        ]);
      }
    }

    const sourceIds: Id[] = [];
    for (const m of matchSources(db, facts)) {
      writePlayerGame(db, m.sourceId, gameId, m.color, facts);
      sourceIds.push(m.sourceId);
    }
    return { gameId, inserted, sourceIds };
  });
}

interface GameSideRow {
  id: Id;
  origin: GameOrigin;
  database_id: Id | null;
  result: GameResult;
  ended_at: EpochMs | null;
  time_class: TimeClass;
  rated: number;
  white: string;
  black: string;
  white_key: string;
  black_key: string;
  white_rating: number | null;
  black_rating: number | null;
  white_title: string | null;
  black_title: string | null;
  white_fide_id: string | null;
  black_fide_id: string | null;
}

/**
 * Adds the missing `player_games` rows of one source from games already stored: a `pgn` source's
 * player in its database, a `fide` source's games in any reference database, or a lichess/chesscom source's
 * games imported while syncing someone else. Existing rows are kept (so `rating_after` survives).
 * Returns the number of rows added. Runs in one transaction.
 */
export function rebuildPlayerGames(db: Db, sourceId: Id): number {
  const src = db.get<{ kind: SourceKind; key: string; database_id: Id | null }>(
    'SELECT kind, key, database_id FROM sources WHERE id = ?',
    [sourceId],
  );
  if (!src) return 0;
  const cols = `id, origin, database_id, result, ended_at, time_class, rated, white, black, white_key, black_key,
    white_rating, black_rating, white_title, black_title, white_fide_id, black_fide_id`;
  let rows: GameSideRow[];
  let isWhite: (r: GameSideRow) => boolean;
  switch (src.kind) {
    case 'lichess':
    case 'chesscom':
      rows = db.all<GameSideRow>(`SELECT ${cols} FROM games WHERE origin = ? AND (white_key = ? OR black_key = ?)`, [
        src.kind,
        src.key,
        src.key,
      ]);
      isWhite = r => r.white_key === src.key;
      break;
    case 'fide':
      rows = db.all<GameSideRow>(
        `SELECT ${cols} FROM games WHERE (white_fide_id = ? OR black_fide_id = ?) AND origin = 'reference'`,
        [src.key, src.key],
      );
      isWhite = r => r.white_fide_id === src.key;
      break;
    case 'pgn': {
      const sep = src.key.indexOf(':');
      const dbId = Number(src.key.slice(0, sep));
      const name = src.key.slice(sep + 1);
      rows = db.all<GameSideRow>(`SELECT ${cols} FROM games WHERE database_id = ? AND (white_key = ? OR black_key = ?)`, [
        dbId,
        name,
        name,
      ]);
      isWhite = r => r.white_key === name;
      break;
    }
  }
  return db.tx(() => {
    let added = 0;
    for (const r of rows) {
      const facts: GameFacts = {
        origin: r.origin,
        databaseId: r.database_id,
        result: r.result,
        endedAt: r.ended_at,
        timeClass: r.time_class,
        rated: r.rated === 1,
        white: { name: r.white, key: r.white_key, rating: r.white_rating, ratingAfter: null, title: r.white_title, fideId: r.white_fide_id },
        black: { name: r.black, key: r.black_key, rating: r.black_rating, ratingAfter: null, title: r.black_title, fideId: r.black_fide_id },
      };
      if (writePlayerGame(db, sourceId, r.id, isWhite(r) ? 'white' : 'black', facts)) added++;
    }
    return added;
  });
}
