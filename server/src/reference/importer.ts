/**
 * The reference import pipeline shared by the three job kinds (PLAN §5, §7):
 *
 *   bytes → (zstd / gzip) → splitPgnGames → parsePgnGames (per game) → toReferenceGame → insertGame
 *
 * in short transactions. Games are split first so one game too large or too complex for the PGN
 * parser is skipped (`tooLarge` / `tooComplex`) instead of ending the whole import.
 *
 * Per batch it deduplicates Lichess broadcast games by study chapter (reference_broadcast_games)
 * before the content hash in `games.origin_id` does the rest. A chapter seen again in a later
 * monthly dump (higher `rank`) replaces the stored game when its moves, result, players or ratings
 * were corrected meanwhile; round imports and files never replace anything. New games are counted
 * into the reference player index (a FIDE player's game once across reference databases), keep
 * `databases.game_count` current and report progress. It yields to the event loop between batches
 * so the API stays responsive, and stops when the job's signal fires. Afterwards existing `fide`
 * sources of the players seen get `rebuildPlayerGames` (a safety net: `insertGame` already links
 * them while importing).
 */
import { setImmediate as nextTick } from 'node:timers/promises';
import { PgnError } from 'chessops/pgn';
import type { Id, JobProgress } from '@outpost/shared/api';
import { getOpeningBook, insertGame, InvalidGameError, parsePgnGames, rebuildPlayerGames, type NormalizedGame } from '../chess/index.ts';
import type { Db } from '../db/index.ts';
import { recountDatabaseGames } from './databases.ts';
import { toReferenceGame, type ReferenceGame, type RoundHints } from './normalize.ts';
import { splitPgnGames } from './pgnSplit.ts';
import { indexReferencePlayer } from './players.ts';

/** Games stored per transaction (~0.3 ms each). */
export const IMPORT_BATCH_SIZE = 100;

/**
 * Counters of one import (`JobProgress.counts`): `imported` (new games), `duplicates`, `skipped`,
 * one per skip reason (`noMoves`, `engine`, `tooComplex`…), and `corrected` when a later monthly
 * dump replaced games stored earlier.
 */
export type ImportCounts = Record<string, number> & { imported: number; duplicates: number; skipped: number };

/** What the importer needs from a job context. */
export interface ImportContext {
  db: Db;
  signal: AbortSignal;
  progress(p: JobProgress): void;
}

/** Options of one import. */
export interface ImportOptions {
  databaseId: Id;
  /** Shown first in progress messages, e.g. "2024-05". */
  label: string;
  /** Hints of a broadcast round import. */
  round?: RoundHints;
  /**
   * Precedence of this import for broadcast chapters already stored: 0 (default) for round imports
   * and files, `YYYYMM` for a monthly dump (see `monthRank`). Only a higher rank replaces.
   */
  rank?: number;
  /** Extra progress text, e.g. "45% of 22 MB". */
  note?: () => string | null;
  batchSize?: number;
}

/** Result of one import. */
export interface ImportResult {
  counts: ImportCounts;
  /** Games read from the PGN (stored, duplicate or skipped). */
  processed: number;
  /** FIDE ids of the players in newly stored games. */
  fideIds: Set<string>;
}

/** Chapter precedence of a monthly dump: `2024-05` → 202405. */
export const monthRank = (month: string): number => Number(month.replace('-', ''));

function message(label: string, c: ImportCounts, note: string | null): string {
  const parts = [`${c.imported} new`, `${c.duplicates} duplicate${c.duplicates === 1 ? '' : 's'}`];
  if (c.corrected) parts.push(`${c.corrected} corrected`);
  parts.push(`${c.skipped} skipped`);
  return `${label}: ${parts.join(', ')}${note ? ` (${note})` : ''}`;
}

interface StoredGame {
  origin_id: string;
  result: string;
  moves_san: string;
  white: string;
  black: string;
  white_rating: number | null;
  black_rating: number | null;
  white_title: string | null;
  black_title: string | null;
  white_fide_id: string | null;
  black_fide_id: string | null;
}

/** True when the stored game says the same as `g` (moves, result, players, ratings, titles, FIDE ids). */
function sameAsStored(db: Db, gameId: Id, g: NormalizedGame): boolean {
  const s = db.get<StoredGame>(
    `SELECT origin_id, result, moves_san, white, black, white_rating, black_rating, white_title, black_title,
            white_fide_id, black_fide_id
       FROM games WHERE id = ?`,
    [gameId],
  );
  if (!s) return false;
  return (
    s.origin_id === g.originId &&
    s.result === g.result &&
    s.moves_san === g.moves.join(' ') &&
    s.white === g.white.name &&
    s.black === g.black.name &&
    s.white_rating === g.white.rating &&
    s.black_rating === g.black.rating &&
    s.white_title === g.white.title &&
    s.black_title === g.black.title &&
    s.white_fide_id === g.white.fideId &&
    s.black_fide_id === g.black.fideId
  );
}

/**
 * True when another reference database already holds this game (same hash part of
 * `<databaseId>:<hash>`): its FIDE players were counted with that copy.
 */
export function hasCopyInOtherReferenceDb(db: Db, databaseId: Id, originId: string): boolean {
  const sep = originId.indexOf(':');
  if (sep < 0) return false;
  return (
    db.value<number>(
      `SELECT 1 FROM databases d
         JOIN games o ON o.origin = 'reference' AND o.origin_id = d.id || ?
        WHERE d.kind = 'reference' AND d.id <> ? LIMIT 1`,
      [originId.slice(sep), databaseId],
    ) !== undefined
  );
}

/** Imports every game of a PGN byte/text stream into a reference database. */
export async function importReferencePgn(
  ctx: ImportContext,
  chunks: AsyncIterable<string | Uint8Array>,
  opts: ImportOptions,
): Promise<ImportResult> {
  const { db, signal } = ctx;
  const { databaseId } = opts;
  const rank = opts.rank ?? 0;
  const batchSize = opts.batchSize ?? IMPORT_BATCH_SIZE;
  const openings = getOpeningBook();
  const counts: ImportCounts = { imported: 0, duplicates: 0, skipped: 0 };
  const fideIds = new Set<string>();
  let processed = 0;
  let batch: ReferenceGame[] = [];

  const count = (key: string): void => {
    counts[key] = (counts[key] ?? 0) + 1;
  };
  const skip = (reason: string): void => {
    counts.skipped++;
    count(reason);
  };

  const report = (): void =>
    ctx.progress({ done: processed, total: null, message: message(opts.label, counts, opts.note?.() ?? null), counts: { ...counts } });

  /** Stores one game (inside the batch transaction); returns +1 when the database gained a game. */
  const store = (g: ReferenceGame): number => {
    let replaces: Id | null = null;
    if (g.chapterKey) {
      const known = db.get<{ game_id: Id; rank: number }>(
        'SELECT game_id, rank FROM reference_broadcast_games WHERE database_id = ? AND chapter_id = ?',
        [databaseId, g.chapterKey],
      );
      if (known) {
        if (rank <= known.rank || sameAsStored(db, known.game_id, g.game)) {
          if (rank > known.rank) {
            db.run('UPDATE reference_broadcast_games SET rank = ? WHERE database_id = ? AND chapter_id = ?', [rank, databaseId, g.chapterKey]);
          }
          counts.duplicates++;
          return 0;
        }
        replaces = known.game_id;
      }
    }
    let r;
    try {
      // A savepoint: an illegal move in the corrected game keeps the stored one.
      r = db.tx(() => {
        // Cascades to positions, player_games and the chapter row; the player index counts down.
        if (replaces !== null) db.run('DELETE FROM games WHERE id = ?', [replaces]);
        return insertGame(db, g.game, { openings });
      });
    } catch (e) {
      if (e instanceof InvalidGameError) {
        skip('illegalMove');
        return 0;
      }
      throw e;
    }
    if (g.chapterKey) {
      db.run(
        `INSERT INTO reference_broadcast_games (database_id, chapter_id, game_id, rank) VALUES (?, ?, ?, ?)
         ON CONFLICT (database_id, chapter_id) DO UPDATE SET game_id = excluded.game_id, rank = MAX(rank, excluded.rank)`,
        [databaseId, g.chapterKey, r.gameId, rank],
      );
    }
    if (!r.inserted) {
      counts.duplicates++;
      return replaces !== null ? -1 : 0;
    }
    if (replaces !== null) count('corrected');
    else counts.imported++;
    const { white, black, endedAt } = g.game;
    // A FIDE player's game counts once across reference databases; name-only rows are per database.
    const counted = hasCopyInOtherReferenceDb(db, databaseId, g.game.originId);
    for (const [p, federation] of [
      [white, g.federations.white],
      [black, g.federations.black],
    ] as const) {
      if (p.fideId && counted) continue;
      indexReferencePlayer(db, databaseId, { ...p, federation }, endedAt);
    }
    if (white.fideId) fideIds.add(white.fideId);
    if (black.fideId) fideIds.add(black.fideId);
    return replaces !== null ? 0 : 1;
  };

  const flush = (): void => {
    if (batch.length === 0) return;
    const games = batch;
    batch = [];
    db.tx(() => {
      let gained = 0;
      for (const g of games) gained += store(g);
      if (gained !== 0) db.run('UPDATE databases SET game_count = MAX(game_count + ?, 0) WHERE id = ?', [gained, databaseId]);
    });
  };

  const take = (pgn: Parameters<typeof toReferenceGame>[0]): void => {
    const g = toReferenceGame(pgn, { databaseId, ...(opts.round ? { round: opts.round } : {}) });
    if ('skip' in g) skip(g.skip);
    else batch.push(g);
  };

  report();
  for await (const piece of splitPgnGames(chunks)) {
    if ('oversized' in piece) {
      processed++;
      skip('tooLarge');
    } else {
      try {
        for await (const pgn of parsePgnGames(piece.text)) {
          processed++;
          take(pgn);
        }
      } catch (e) {
        if (!(e instanceof PgnError)) throw e;
        // chessops' complexity budget (ERR_PGN_BUDGET): too many moves, variations or comments.
        processed++;
        skip('tooComplex');
      }
    }
    if (batch.length >= batchSize || processed % (batchSize * 10) === 0) {
      signal.throwIfAborted();
      flush();
      report();
      await nextTick();
    }
  }
  signal.throwIfAborted();
  flush();
  recountDatabaseGames(db, databaseId);
  linkFideSources(db, fideIds);
  report();
  return { counts, processed, fideIds };
}

/** Runs `rebuildPlayerGames` for the existing `fide` sources among `fideIds`. Returns rows added. */
export function linkFideSources(db: Db, fideIds: ReadonlySet<string>): number {
  if (fideIds.size === 0) return 0;
  let added = 0;
  for (const s of db.all<{ id: Id; key: string }>("SELECT id, key FROM sources WHERE kind = 'fide'")) {
    if (fideIds.has(s.key)) added += rebuildPlayerGames(db, s.id);
  }
  return added;
}
