/**
 * Worker thread entry of `countHeavyRowsInWorker` (src/auth/rowCounts.ts): opens the database
 * read-only, counts, posts one `CountsMessage` and exits.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { openDb } from '../db/index.ts';
import { countHeavyRows, type CountsMessage } from './rowCounts.ts';

const { dbPath } = workerData as { dbPath: string };
let message: CountsMessage;
try {
  const db = openDb(dbPath, { readOnly: true });
  try {
    message = { ok: true, counts: countHeavyRows(db) };
  } finally {
    // Not db.close(): its `PRAGMA optimize` is for the server's own read-write connection.
    db.raw.close();
  }
} catch (err) {
  message = { ok: false, error: err instanceof Error ? err.message : String(err) };
}
parentPort?.postMessage(message);
