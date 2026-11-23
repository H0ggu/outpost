-- 600_reference: reference databases, broadcast import bookkeeping and the reference player index
-- (docs/PLAN.md §4–§6; owner: reference). Games themselves live in `games` (origin 'reference').

-- Extra metadata of reference databases (`databases.kind = 'reference'`).
-- builtin: 'lichess-broadcasts' for the built-in "Lichess broadcasts" database (created on first
-- import), NULL for databases the admin creates by importing a PGN.
CREATE TABLE reference_databases (
  database_id INTEGER PRIMARY KEY REFERENCES databases (id) ON DELETE CASCADE,
  builtin     TEXT    UNIQUE,
  created_at  INTEGER NOT NULL
) STRICT;

-- database.lichess.org broadcast months imported into a reference database.
-- status: 'imported' (finished), 'error' (last attempt failed; `error` says why).
-- games = games of that month now stored (new + already present), the rest are counters of the last run.
CREATE TABLE reference_broadcast_months (
  database_id INTEGER NOT NULL REFERENCES databases (id) ON DELETE CASCADE,
  month       TEXT    NOT NULL CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
  status      TEXT    NOT NULL CHECK (status IN ('imported', 'error')),
  games       INTEGER NOT NULL DEFAULT 0,
  imported    INTEGER NOT NULL DEFAULT 0,
  duplicates  INTEGER NOT NULL DEFAULT 0,
  skipped     INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,
  imported_at INTEGER,
  error       TEXT,
  PRIMARY KEY (database_id, month)
) STRICT, WITHOUT ROWID;

-- Lichess broadcast rounds imported through the API ('broadcastRound' jobs, auto-import).
-- status: 'imported' (round finished, all games stored), 'partial' (round still running when it was
-- imported: only finished games stored), 'error'.
CREATE TABLE reference_broadcast_rounds (
  database_id INTEGER NOT NULL REFERENCES databases (id) ON DELETE CASCADE,
  round_id    TEXT    NOT NULL,
  tour_id     TEXT,
  tour_name   TEXT,
  round_name  TEXT,
  status      TEXT    NOT NULL CHECK (status IN ('imported', 'partial', 'error')),
  games       INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,
  error       TEXT,
  PRIMARY KEY (database_id, round_id)
) STRICT, WITHOUT ROWID;

-- Lichess broadcast games by study chapter id (the last segment of the PGN GameURL tag), so a game
-- seen in a round import and again in a monthly dump (or in two dumps) is stored once even when its
-- names, dates or annotations were corrected in between. The content hash in games.origin_id
-- covers everything else.
CREATE TABLE reference_broadcast_games (
  database_id INTEGER NOT NULL REFERENCES databases (id) ON DELETE CASCADE,
  chapter_id  TEXT    NOT NULL,
  game_id     INTEGER NOT NULL REFERENCES games (id) ON DELETE CASCADE,
  PRIMARY KEY (database_id, chapter_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX reference_broadcast_games_game ON reference_broadcast_games (game_id);

-- Reference player index (search, FIDE player pages). One row per FIDE id across every reference
-- database; players without a FIDE id get one row per database and name (playerKey).
--   search_name: folded name for search (lowercase ASCII words, see src/reference/players.ts)
--   last_*: from the player's most recent game; max_rating over all games.
CREATE TABLE reference_players (
  id          INTEGER PRIMARY KEY,
  fide_id     TEXT,
  database_id INTEGER REFERENCES databases (id) ON DELETE CASCADE,
  name_key    TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  search_name TEXT    NOT NULL,
  title       TEXT,
  federation  TEXT,
  games       INTEGER NOT NULL DEFAULT 0,
  last_played INTEGER,
  last_rating INTEGER,
  max_rating  INTEGER,
  updated_at  INTEGER NOT NULL,
  CHECK ((fide_id IS NULL) <> (database_id IS NULL))
) STRICT;
CREATE UNIQUE INDEX reference_players_fide ON reference_players (fide_id) WHERE fide_id IS NOT NULL;
CREATE UNIQUE INDEX reference_players_name ON reference_players (database_id, name_key) WHERE fide_id IS NULL;
CREATE INDEX reference_players_games ON reference_players (games DESC);

-- Keep game counts right when reference games go away (a deleted game, or a whole database via
-- ON DELETE CASCADE, which fires this trigger too). Inserts are counted by the importer.
CREATE TRIGGER reference_players_game_deleted AFTER DELETE ON games WHEN old.origin = 'reference'
BEGIN
  UPDATE reference_players SET games = MAX(games - 1, 0) WHERE fide_id = old.white_fide_id;
  UPDATE reference_players SET games = MAX(games - 1, 0)
   WHERE old.white_fide_id IS NULL AND fide_id IS NULL AND database_id = old.database_id AND name_key = old.white_key;
  UPDATE reference_players SET games = MAX(games - 1, 0) WHERE fide_id = old.black_fide_id;
  UPDATE reference_players SET games = MAX(games - 1, 0)
   WHERE old.black_fide_id IS NULL AND fide_id IS NULL AND database_id = old.database_id AND name_key = old.black_key;
END;
