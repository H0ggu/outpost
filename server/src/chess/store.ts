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
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import { Chess } from 'chessops/chess';
import { makeSanAndPlay, parseSan } from 'chessops/san';
import type { EpochMs, GameOrigin, GameResult, Id, SourceKind, Termination, TimeClass, Title } from '@outpost/shared/api';
import { colorChar, epdOf, outcomeFor, playerKey, stdUci, type Color } from '@outpost/shared/chess';
import type { Db } from '../db/index.ts';
import { classifyOpening, getOpeningBook, type OpeningBook, type OpeningMatch } from './openings.ts';
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
  /**
   * Sources that now have a player_games row for this game (a `fide` source skipped because
   * another reference database's copy of the game is already linked to it is not listed).
   */
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

/**
 * Sources that played this game, with their colour (PLAN §7: one row per source that appears).
 *
 * `fide` sources link **games of public reference databases only** (PLAN §5 "A FIDE player profile
 * is built from reference-DB games"; docs/DECISIONS.md): a WhiteFideId / BlackFideId tag in a
 * user's PGN database never puts that game on a (possibly public) FIDE profile, and neither does
 * an admin's private reference database. The trigger `reference_fide_player_games` (migrations
 * 601, 602) enforces the rule for every writer and also keeps one copy per game when several
 * reference databases hold it (the first copy stored wins).
 */
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
      if (g.origin === 'reference') add('fide', side.fideId, color);
    }
  }
  return out;
}

const INSERT_PLAYER_GAME = `INSERT OR IGNORE INTO player_games
  (source_id, game_id, color, outcome, rating, rating_after, opp_name, opp_key, opp_rating, opp_title,
   opp_source_kind, ended_at, time_class, rated)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/** Same row, but an existing one takes this import's ratings and titles (the source's own sync knows best). */
const UPSERT_PLAYER_GAME = `INSERT INTO player_games
  (source_id, game_id, color, outcome, rating, rating_after, opp_name, opp_key, opp_rating, opp_title,
   opp_source_kind, ended_at, time_class, rated)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (source_id, game_id) DO UPDATE SET
    rating = excluded.rating,
    rating_after = COALESCE(excluded.rating_after, player_games.rating_after),
    opp_rating = excluded.opp_rating,
    opp_title = COALESCE(excluded.opp_title, player_games.opp_title)`;

function writePlayerGame(db: Db, sourceId: Id, gameId: Id, color: Color, g: GameFacts, refresh = false): boolean {
  const me = g[color];
  const opp = g[color === 'white' ? 'black' : 'white'];
  const oppId = opponentIdentity(g.origin, opp);
  const r = db.run(refresh ? UPSERT_PLAYER_GAME : INSERT_PLAYER_GAME, [
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

/** What `insertGame` derives from the moves. */
interface MoveAnalysis {
  sans: string[];
  /** EPD after 0…min(50, plies) plies. */
  epds: string[];
  /** Move played from each of those positions (standard castling). */
  ucis: string[];
  opening: OpeningMatch | null;
}

/** Validates and normalises the SAN mainline, and derives positions and the opening. */
function analyseMoves(moves: readonly string[], book: OpeningBook): MoveAnalysis {
  const pos = Chess.default();
  const epds = [epdOf(pos)];
  const ucis: string[] = [];
  const sans: string[] = [];
  for (const [i, san] of moves.entries()) {
    const move = parseSan(pos, san);
    if (!move) throw new InvalidGameError(`Illegal or unparsable move ${JSON.stringify(san)} at ply ${i + 1}`);
    if (i < POSITION_MAX_PLY + 1) ucis.push(stdUci(pos, move));
    sans.push(makeSanAndPlay(pos, move));
    if (i + 1 <= POSITION_MAX_PLY) epds.push(epdOf(pos));
  }
  return { sans, epds, ucis, opening: classifyOpening(book, epds) };
}

function writePositions(db: Db, gameId: Id, epds: readonly string[], ucis: readonly string[]): void {
  for (const [ply, epd] of epds.entries()) {
    db.run('INSERT INTO positions (game_id, ply, pos_key, next_uci) VALUES (?, ?, ?, ?)', [gameId, ply, posKey(epd), ucis[ply] ?? null]);
  }
}

/**
 * Stores one game: validates and normalises the moves, classifies the opening, writes `games`,
 * `positions` (plies 0…50) and a `player_games` row for every existing source that played it
 * (matched by kind and key: lichess/chesscom username, `pgn` `<dbId>:<name>`, `fide` id).
 * Idempotent: a duplicate returns the stored id with `inserted: false`.
 * Synchronous; call it inside `db.tx()` in batches (e.g. 500 games per transaction).
 * Throws `InvalidGameError` for an illegal move.
 *
 * `opts.sourceId`: the source whose own sync produced this game. Its existing `player_games` row
 * (written earlier while syncing the opponent, with less precise ratings) takes this game's
 * ratings and titles; every other source's row is only created when missing.
 */
export function insertGame(
  db: Db,
  game: NormalizedGame,
  opts: { openings?: OpeningBook; sourceId?: Id } = {},
): InsertGameResult {
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
      const { sans, epds, ucis, opening } = analyseMoves(game.moves, opts.openings ?? getOpeningBook());

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

      writePositions(db, gameId, epds, ucis);
    }

    const sourceIds: Id[] = [];
    for (const m of matchSources(db, facts)) {
      const written = writePlayerGame(db, m.sourceId, gameId, m.color, facts, m.sourceId === opts.sourceId);
      // Not written: the row existed already, or migration 601's trigger skipped a second copy.
      if (written || db.value('SELECT 1 FROM player_games WHERE source_id = ? AND game_id = ?', [m.sourceId, gameId]) !== undefined) {
        sourceIds.push(m.sourceId);
      }
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

const GAME_SIDE_COLUMNS = `id, origin, database_id, result, ended_at, time_class, rated, white, black, white_key, black_key,
    white_rating, black_rating, white_title, black_title, white_fide_id, black_fide_id`;

/** A source's games from one side: the indexed column, its value and the extra conditions. */
interface SideQuery {
  color: Color;
  sql: string;
  params: Array<string | number>;
}

/**
 * The queries that find a source's games, one per side. Each reads one index (`white_key`,
 * `black_key`, `white_fide_id`, `black_fide_id`, all ordered by rowid within a value), so batches
 * can walk it by id. Games of a `fide` source: public reference databases only (migration 602).
 */
function sourceSideQueries(db: Db, sourceId: Id): SideQuery[] | null {
  const src = db.get<{ kind: SourceKind; key: string }>('SELECT kind, key FROM sources WHERE id = ?', [sourceId]);
  if (!src) return null;
  return (['white', 'black'] as const).map(color => {
    switch (src.kind) {
      case 'lichess':
      case 'chesscom':
        return { color, sql: `${color}_key = ? AND origin = ?`, params: [src.key, src.kind] };
      case 'fide':
        return {
          color,
          sql: `${color}_fide_id = ? AND origin = 'reference'
                AND database_id IN (SELECT id FROM databases WHERE kind = 'reference' AND visibility = 'public')`,
          params: [src.key],
        };
      case 'pgn': {
        const sep = src.key.indexOf(':');
        return { color, sql: `${color}_key = ? AND database_id = ?`, params: [src.key.slice(sep + 1), Number(src.key.slice(0, sep))] };
      }
    }
  });
}

/** Writes the missing rows of `sourceId` for these games, playing `color`. */
function linkRows(db: Db, sourceId: Id, color: Color, rows: readonly GameSideRow[]): number {
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
    if (writePlayerGame(db, sourceId, r.id, color, facts)) added++;
  }
  return added;
}

/**
 * Adds the missing `player_games` rows of one source from games already stored: a `pgn` source's
 * player in its database, a `fide` source's games in the public reference databases (one copy per
 * game, oldest first: see `matchSources`), or a lichess/chesscom source's games imported while
 * syncing someone else. Existing rows are kept (so `rating_after` survives).
 * Returns the number of rows added. Runs in one transaction: for a source with many games use
 * `rebuildPlayerGamesInBatches`, which lets the server breathe in between.
 */
export function rebuildPlayerGames(db: Db, sourceId: Id): number {
  const sides = sourceSideQueries(db, sourceId);
  if (!sides) return 0;
  return db.tx(() => {
    let added = 0;
    for (const side of sides) {
      const rows = db.all<GameSideRow>(`SELECT ${GAME_SIDE_COLUMNS} FROM games WHERE ${side.sql} ORDER BY id`, side.params);
      added += linkRows(db, sourceId, side.color, rows);
    }
    return added;
  });
}

/** Games per transaction of `rebuildPlayerGamesInBatches`. */
export const REBUILD_LINK_BATCH = 2000;

/**
 * `rebuildPlayerGames` in batches of `batchSize` games (by id, through the side's index), each in
 * its own transaction, yielding to the event loop in between, so linking a player with millions of
 * stored games never holds the server. Stops between batches when `signal` aborts (throws its
 * reason). Returns the number of rows added.
 */
export async function rebuildPlayerGamesInBatches(
  db: Db,
  sourceId: Id,
  opts: { signal?: AbortSignal; batchSize?: number } = {},
): Promise<number> {
  const sides = sourceSideQueries(db, sourceId);
  if (!sides) return 0;
  const batchSize = Math.max(1, opts.batchSize ?? REBUILD_LINK_BATCH);
  let added = 0;
  for (const side of sides) {
    let after = 0;
    for (;;) {
      opts.signal?.throwIfAborted();
      const rows = db.all<GameSideRow>(`SELECT ${GAME_SIDE_COLUMNS} FROM games WHERE ${side.sql} AND id > ? ORDER BY id LIMIT ?`, [
        ...side.params,
        after,
        batchSize,
      ]);
      if (rows.length === 0) break;
      added += db.tx(() => linkRows(db, sourceId, side.color, rows));
      after = rows[rows.length - 1]!.id;
      if (rows.length < batchSize) break;
      await yieldToLoop();
    }
  }
  return added;
}

/**
 * After an admin changed a reference database's visibility: `fide` sources link games of public
 * reference databases only (migration 602), so each FIDE source with a game in that database
 * drops its rows for games of non-public databases and gets the missing ones back (this
 * database's games when it became public, another public database's copy of a game when it
 * became private). Returns the number of sources relinked. Runs in one transaction.
 */
export function relinkFideSources(db: Db, databaseId: Id): number {
  return db.tx(() => {
    const ids = db
      .all<{ id: Id }>(
        `SELECT s.id FROM sources s
          WHERE s.kind = 'fide'
            AND (EXISTS (SELECT 1 FROM games g WHERE g.white_fide_id = s.key AND g.database_id = ?1)
              OR EXISTS (SELECT 1 FROM games g WHERE g.black_fide_id = s.key AND g.database_id = ?1))`,
        [databaseId],
      )
      .map(r => r.id);
    for (const id of ids) {
      db.run(
        `DELETE FROM player_games AS pg
          WHERE pg.source_id = ?
            AND (SELECT d.visibility FROM games g JOIN databases d ON d.id = g.database_id WHERE g.id = pg.game_id) IS NOT 'public'`,
        [id],
      );
      rebuildPlayerGames(db, id);
    }
    return ids.length;
  });
}

/**
 * Recomputes the derived data of stored games from their `moves_san`: the opening (after an
 * update of the chess-openings book) and the `positions` rows. Games whose moves no longer parse
 * are left alone and counted. Runs in one transaction; call it in batches.
 */
export function reindexGames(
  db: Db,
  gameIds: readonly Id[],
  opts: { openings?: OpeningBook } = {},
): { updated: number; invalid: number } {
  const book = opts.openings ?? getOpeningBook();
  return db.tx(() => {
    let updated = 0;
    let invalid = 0;
    for (const id of gameIds) {
      const moves = db.value<string>('SELECT moves_san FROM games WHERE id = ?', [id]);
      if (moves === undefined) continue;
      let a: MoveAnalysis;
      try {
        a = analyseMoves(moves ? moves.split(' ') : [], book);
      } catch (e) {
        if (e instanceof InvalidGameError) {
          invalid++;
          continue;
        }
        throw e;
      }
      db.run('UPDATE games SET eco = ?, opening_name = ?, opening_ply = ?, ply_count = ?, moves_san = ? WHERE id = ?', [
        a.opening?.eco ?? null,
        a.opening?.name ?? null,
        a.opening?.ply ?? null,
        a.sans.length,
        a.sans.join(' '),
        id,
      ]);
      db.run('DELETE FROM positions WHERE game_id = ?', [id]);
      writePositions(db, id, a.epds, a.ucis);
      updated++;
    }
    return { updated, invalid };
  });
}

/**
 * Fills in opponent titles learnt later (Chess.com game objects carry no titles; the geo lookup
 * finds them on the player's profile): `games.white_title`/`black_title` of that site's games and
 * `player_games.opp_title`, only where still unknown. Returns the number of rows changed.
 */
export function backfillPlayerTitle(db: Db, kind: 'lichess' | 'chesscom', key: string, title: Title): number {
  return db.tx(() => {
    let n = db.run('UPDATE games SET white_title = ? WHERE origin = ? AND white_key = ? AND white_title IS NULL', [title, kind, key]).changes;
    n += db.run('UPDATE games SET black_title = ? WHERE origin = ? AND black_key = ? AND black_title IS NULL', [title, kind, key]).changes;
    n += db.run('UPDATE player_games SET opp_title = ? WHERE opp_source_kind = ? AND opp_key = ? AND opp_title IS NULL', [title, kind, key])
      .changes;
    return n;
  });
}
