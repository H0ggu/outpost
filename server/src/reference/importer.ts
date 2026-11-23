/**
 * The reference import pipeline shared by the three job kinds (PLAN §5, §7):
 *
 *   bytes → (zstd / gzip) → parsePgnGames → toReferenceGame → insertGame, in short transactions
 *
 * Per batch it deduplicates Lichess broadcast games by study chapter (reference_broadcast_games)
 * before the content hash in `games.origin_id` does the rest, counts new players into the
 * reference index, keeps `databases.game_count` current and reports progress. It yields to the
 * event loop between batches so the API stays responsive, and stops when the job's signal fires.
 * Afterwards existing `fide` sources of the players seen get `rebuildPlayerGames` (a safety net:
 * `insertGame` already links them while importing).
 */
import { setImmediate as nextTick } from 'node:timers/promises';
import type { Id, JobProgress } from '@outpost/shared/api';
import { getOpeningBook, insertGame, InvalidGameError, parsePgnGames, rebuildPlayerGames } from '../chess/index.ts';
import type { Db } from '../db/index.ts';
import { recountDatabaseGames } from './databases.ts';
import { toReferenceGame, type ReferenceGame, type RoundHints } from './normalize.ts';
import { indexReferencePlayer } from './players.ts';

/** Games stored per transaction (~0.3 ms each). */
export const IMPORT_BATCH_SIZE = 100;

/** Counters of one import (`JobProgress.counts`): `imported`, `duplicates`, `skipped`, plus one per skip reason. */
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

function message(label: string, c: ImportCounts, note: string | null): string {
  const parts = [`${c.imported} new`, `${c.duplicates} duplicate${c.duplicates === 1 ? '' : 's'}`, `${c.skipped} skipped`];
  return `${label}: ${parts.join(', ')}${note ? ` (${note})` : ''}`;
}

/** Imports every game of a PGN byte/text stream into a reference database. */
export async function importReferencePgn(
  ctx: ImportContext,
  chunks: AsyncIterable<string | Uint8Array>,
  opts: ImportOptions,
): Promise<ImportResult> {
  const { db, signal } = ctx;
  const { databaseId } = opts;
  const batchSize = opts.batchSize ?? IMPORT_BATCH_SIZE;
  const openings = getOpeningBook();
  const counts: ImportCounts = { imported: 0, duplicates: 0, skipped: 0 };
  const fideIds = new Set<string>();
  let processed = 0;
  let batch: ReferenceGame[] = [];

  const skip = (reason: string): void => {
    counts.skipped++;
    counts[reason] = (counts[reason] ?? 0) + 1;
  };

  const report = (): void =>
    ctx.progress({ done: processed, total: null, message: message(opts.label, counts, opts.note?.() ?? null), counts: { ...counts } });

  const flush = (): void => {
    if (batch.length === 0) return;
    const games = batch;
    batch = [];
    db.tx(() => {
      let inserted = 0;
      for (const g of games) {
        if (g.chapterKey) {
          const known = db.value<Id>('SELECT game_id FROM reference_broadcast_games WHERE database_id = ? AND chapter_id = ?', [
            databaseId,
            g.chapterKey,
          ]);
          if (known !== undefined) {
            counts.duplicates++;
            continue;
          }
        }
        let r;
        try {
          r = insertGame(db, g.game, { openings });
        } catch (e) {
          if (e instanceof InvalidGameError) {
            skip('illegalMove');
            continue;
          }
          throw e;
        }
        if (g.chapterKey) {
          db.run('INSERT OR IGNORE INTO reference_broadcast_games (database_id, chapter_id, game_id) VALUES (?, ?, ?)', [
            databaseId,
            g.chapterKey,
            r.gameId,
          ]);
        }
        if (!r.inserted) {
          counts.duplicates++;
          continue;
        }
        counts.imported++;
        inserted++;
        const { white, black, endedAt } = g.game;
        indexReferencePlayer(db, databaseId, { ...white, federation: g.federations.white }, endedAt);
        indexReferencePlayer(db, databaseId, { ...black, federation: g.federations.black }, endedAt);
        if (white.fideId) fideIds.add(white.fideId);
        if (black.fideId) fideIds.add(black.fideId);
      }
      if (inserted > 0) db.run('UPDATE databases SET game_count = game_count + ? WHERE id = ?', [inserted, databaseId]);
    });
  };

  report();
  for await (const pgn of parsePgnGames(chunks)) {
    processed++;
    const g = toReferenceGame(pgn, { databaseId, ...(opts.round ? { round: opts.round } : {}) });
    if ('skip' in g) skip(g.skip);
    else batch.push(g);
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
