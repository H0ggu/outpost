-- 503_files_quota: per-user limits of Studio files (profiles module, src/files/index.ts).
--
-- files.pgn_bytes = UTF-8 size of files.pgn, written with every save. The covering index answers
-- "bytes stored by this user" without reading the (large) PGN rows.
-- file_index.positions = rows the file has in file_positions (the per-user position budget).
ALTER TABLE files ADD COLUMN pgn_bytes INTEGER NOT NULL DEFAULT 0;
UPDATE files SET pgn_bytes = length(CAST(pgn AS BLOB));
CREATE INDEX files_owner_bytes ON files (owner_user_id, pgn_bytes);

ALTER TABLE file_index ADD COLUMN positions INTEGER NOT NULL DEFAULT 0;
UPDATE file_index SET positions = (SELECT COUNT(*) FROM file_positions fp WHERE fp.file_id = file_index.file_id);
