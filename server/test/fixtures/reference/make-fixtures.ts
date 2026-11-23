/**
 * Regenerates the zstd fixtures from the synthetic PGNs next to this file:
 *   node server/test/fixtures/reference/make-fixtures.ts
 * (node:zlib zstdCompressSync; the reference tests also check that each .zst matches its .pgn).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { zstdCompressSync } from 'node:zlib';

for (const name of ['broadcast-2026-01', 'broadcast-2026-02']) {
  const pgn = readFileSync(new URL(`./${name}.pgn`, import.meta.url));
  writeFileSync(new URL(`./${name}.pgn.zst`, import.meta.url), zstdCompressSync(pgn));
}
