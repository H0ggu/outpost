-- 503_files_bytes: per-user storage quota of Studio files (profiles module, src/files/index.ts).
--
-- pgn_bytes = UTF-8 size of files.pgn, written with every save. The covering index answers
-- "bytes stored by this user" without reading the (large) PGN rows.
ALTER TABLE files ADD COLUMN pgn_bytes INTEGER NOT NULL DEFAULT 0;
UPDATE files SET pgn_bytes = length(CAST(pgn AS BLOB));
CREATE INDEX files_owner_bytes ON files (owner_user_id, pgn_bytes);
