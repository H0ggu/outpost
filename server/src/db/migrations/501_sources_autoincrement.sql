-- 501_sources_autoincrement: source ids are never reused (profiles module, PLAN §4 sources).
--
-- `sources.id` keys more than the table's own foreign keys: the sync job's dedupe key
-- `sync:<sourceId>` and its payload, and caches of other modules. Without AUTOINCREMENT SQLite
-- hands the id of a deleted source (the orphan policy in src/profiles/service.ts deletes sources
-- no profile uses) to the next new one, which could then inherit a stale queued or running sync
-- job of the old account, even on the other site's lane. With AUTOINCREMENT every new source gets
-- an id larger than any id ever used. Same columns, constraints and index as 001_init.sql.
-- outpost:foreign-keys-off

CREATE TABLE sources_new (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT    NOT NULL CHECK (kind IN ('lichess', 'chesscom', 'fide', 'pgn')),
  key             TEXT    NOT NULL,               -- lowercase username | FIDE id | '<databaseId>:<player name>'
  display_name    TEXT    NOT NULL,
  site_user_id    TEXT,                           -- Lichess user id, Chess.com player_id / uuid
  title           TEXT,
  country         TEXT,                           -- ISO 3166-1 alpha-2
  database_id     INTEGER REFERENCES databases (id) ON DELETE CASCADE, -- pgn sources only
  profile_json    TEXT,                           -- last upstream profile/stats snapshot
  sync_state_json TEXT,                           -- importer cursor (since, archive ETags, ...)
  last_synced_at  INTEGER,
  last_sync_error TEXT,
  created_at      INTEGER NOT NULL,
  UNIQUE (kind, key)
) STRICT;

INSERT INTO sources_new (id, kind, key, display_name, site_user_id, title, country, database_id, profile_json,
                         sync_state_json, last_synced_at, last_sync_error, created_at)
  SELECT id, kind, key, display_name, site_user_id, title, country, database_id, profile_json,
         sync_state_json, last_synced_at, last_sync_error, created_at
    FROM sources;

DROP TABLE sources;
ALTER TABLE sources_new RENAME TO sources;
CREATE INDEX sources_database ON sources (database_id) WHERE database_id IS NOT NULL;
