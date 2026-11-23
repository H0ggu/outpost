-- 500_databases_files: profiles module tables (docs/PLAN.md §4 databases/files, §5).

-- Display order of a profile's accounts (the order they were added).
ALTER TABLE profile_sources ADD COLUMN position INTEGER NOT NULL DEFAULT 0;

-- PGN imports into user databases: which job imported into which database, so DatabaseInfo can
-- show the latest import (and its summary) without scanning `jobs` payloads. Rows go with their
-- job (jobs.id) or their database. `file` is the upload's basename in DATA_DIR/uploads while it
-- is still pending; the pgnImport handler clears it once the file is gone.
CREATE TABLE database_imports (
  job_id      INTEGER PRIMARY KEY REFERENCES jobs (id) ON DELETE CASCADE,
  database_id INTEGER NOT NULL REFERENCES databases (id) ON DELETE CASCADE,
  file        TEXT,
  created_at  INTEGER NOT NULL
) STRICT;
CREATE INDEX database_imports_database ON database_imports (database_id, job_id);

-- Position index of Studio files for GET /api/files/search?fen= (PLAN §8.4). Built lazily per
-- file the first time a search needs it, and dropped whenever the file's PGN changes, so a row
-- in file_index always describes the file's current revision.
-- ply: lila's ply of the position (half-moves from the initial position of the game, counting the
-- FEN's move number when the game starts from a set-up position); next_san: the move played from
-- here in that line, NULL at the end of a line.
CREATE TABLE file_index (
  file_id    INTEGER PRIMARY KEY REFERENCES files (id) ON DELETE CASCADE,
  indexed_at INTEGER NOT NULL,
  games      INTEGER NOT NULL,
  error      TEXT                                  -- why (part of) the PGN could not be indexed
) STRICT;

CREATE TABLE file_positions (
  file_id    INTEGER NOT NULL REFERENCES files (id) ON DELETE CASCADE,
  pos_key    INTEGER NOT NULL,                     -- posKey(chessops EPD), as positions.pos_key
  game_index INTEGER NOT NULL,
  ply        INTEGER NOT NULL,
  next_san   TEXT
) STRICT;
CREATE INDEX file_positions_key ON file_positions (pos_key, file_id);
CREATE INDEX file_positions_file ON file_positions (file_id);
