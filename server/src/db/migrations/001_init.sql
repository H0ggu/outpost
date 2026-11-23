-- 001_init: core schema (docs/PLAN.md §4).
--
-- Conventions
--   * Times are INTEGER epoch milliseconds (UTC).
--   * Booleans are INTEGER 0/1 with CHECK constraints.
--   * *_json columns hold JSON text validated by the application.
--   * Tables are STRICT (column types enforced).
--   * Each migration runs in one transaction (src/db/migrate.ts); no PRAGMAs here.
--   * Later modules add migrations in their reserved ranges: auth 100-199, sync/jobs 200-299,
--     stats 300-399, explorer 400-499, profiles/db/files 500-599, reference/broadcasts 600-699,
--     prep 700-799.

-- ---------------------------------------------------------------------------
-- Accounts and sessions (PLAN §10)
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT    NOT NULL,                 -- scrypt, encoded by the auth module
  role          TEXT    NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  disabled      INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
  totp_secret   TEXT,                             -- base32; NULL = TOTP off
  created_at    INTEGER NOT NULL,
  prefs_json    TEXT    NOT NULL DEFAULT '{}'     -- UserPrefs (shared/src/api.ts); missing keys = defaults
) STRICT;

CREATE TABLE sessions (
  id_hash      TEXT    PRIMARY KEY,               -- hex SHA-256 of the random cookie value
  user_id      INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,                  -- sliding 30-day expiry
  last_seen_at INTEGER NOT NULL,
  ip           TEXT,
  user_agent   TEXT
) STRICT, WITHOUT ROWID;
CREATE INDEX sessions_user ON sessions (user_id);
CREATE INDEX sessions_expires ON sessions (expires_at);

CREATE TABLE invites (
  code       TEXT    PRIMARY KEY,
  created_by INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,                             -- NULL = never
  used_by    INTEGER REFERENCES users (id) ON DELETE SET NULL,
  used_at    INTEGER
) STRICT, WITHOUT ROWID;

-- Key/value instance settings (src/settings.ts). `value` is JSON.
CREATE TABLE instance_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT, WITHOUT ROWID;

-- ---------------------------------------------------------------------------
-- Databases (user PGN collections and reference DBs)
-- ---------------------------------------------------------------------------

CREATE TABLE databases (
  id            INTEGER PRIMARY KEY,
  owner_user_id INTEGER REFERENCES users (id) ON DELETE CASCADE, -- NULL for system reference DBs
  name          TEXT    NOT NULL,
  kind          TEXT    NOT NULL CHECK (kind IN ('games', 'reference')),
  visibility    TEXT    NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public')),
  source_label  TEXT,
  licence       TEXT,
  created_at    INTEGER NOT NULL,
  game_count    INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX databases_owner ON databases (owner_user_id);
CREATE INDEX databases_kind ON databases (kind, visibility);

-- ---------------------------------------------------------------------------
-- Sources (sync identities) and profiles
-- ---------------------------------------------------------------------------

CREATE TABLE sources (
  id              INTEGER PRIMARY KEY,
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
CREATE INDEX sources_database ON sources (database_id) WHERE database_id IS NOT NULL;

CREATE TABLE profiles (
  id                  INTEGER PRIMARY KEY,
  slug                TEXT    NOT NULL UNIQUE,    -- [a-z0-9][a-z0-9-]{1,63}
  display_name        TEXT    NOT NULL,
  owner_user_id       INTEGER REFERENCES users (id) ON DELETE CASCADE,
  visibility          TEXT    NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public')),
  auto_refresh        INTEGER NOT NULL DEFAULT 0 CHECK (auto_refresh IN (0, 1)),
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  views               INTEGER NOT NULL DEFAULT 0,
  update_requested_at INTEGER                     -- last manual update (cooldown, PLAN §7)
) STRICT;
CREATE INDEX profiles_owner ON profiles (owner_user_id);
CREATE INDEX profiles_visibility ON profiles (visibility, updated_at);
CREATE INDEX profiles_auto_refresh ON profiles (auto_refresh) WHERE auto_refresh = 1;

CREATE TABLE profile_sources (
  profile_id INTEGER NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  source_id  INTEGER NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
  hidden     INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
  PRIMARY KEY (profile_id, source_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX profile_sources_source ON profile_sources (source_id);

CREATE TABLE bookmarks (
  user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  profile_id INTEGER NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, profile_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX bookmarks_profile ON bookmarks (profile_id);

-- "Recently viewed" for GET /api/profiles?scope=recent (one row per user and profile).
CREATE TABLE profile_views (
  user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  profile_id INTEGER NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  viewed_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, profile_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX profile_views_recent ON profile_views (user_id, viewed_at);

-- ---------------------------------------------------------------------------
-- Games
-- ---------------------------------------------------------------------------

-- One row per distinct game. Standard chess only: no variants, engines or from-position games.
-- origin_id: Lichess game id | Chess.com game uuid |
--            '<databaseId>:<dedupe hash>' for 'pgn' and 'reference' (the hash covers colours, date,
--            players and the position after ply 80 or the final position, PLAN §5), so the
--            UNIQUE constraint doubles as the duplicate check.
CREATE TABLE games (
  id             INTEGER PRIMARY KEY,
  origin         TEXT    NOT NULL CHECK (origin IN ('lichess', 'chesscom', 'pgn', 'reference')),
  origin_id      TEXT    NOT NULL,
  url            TEXT,
  database_id    INTEGER REFERENCES databases (id) ON DELETE CASCADE,
  white          TEXT    NOT NULL,
  black          TEXT    NOT NULL,
  white_key      TEXT    NOT NULL,                -- playerKey(white): NFC, trimmed, lowercase
  black_key      TEXT    NOT NULL,
  white_rating   INTEGER,                         -- pre-game where the site allows (Chess.com: see PLAN §7)
  black_rating   INTEGER,
  white_title    TEXT,
  black_title    TEXT,
  white_fide_id  TEXT,
  black_fide_id  TEXT,
  result         TEXT    NOT NULL CHECK (result IN ('1-0', '0-1', '1/2-1/2')),
  termination    TEXT    NOT NULL DEFAULT 'other' CHECK (termination IN (
                   'mate', 'resign', 'timeout', 'abandon', 'agreement', 'repetition', 'stalemate',
                   'insufficient', 'fifty', 'timeout_vs_insufficient', 'other')),
  time_class     TEXT    NOT NULL DEFAULT 'unknown' CHECK (time_class IN (
                   'bullet', 'blitz', 'rapid', 'classical', 'correspondence', 'unknown')),
  time_control   TEXT,                            -- PGN form: '180+2', '600', '1/259200'
  rated          INTEGER NOT NULL DEFAULT 0 CHECK (rated IN (0, 1)),
  variant        TEXT    NOT NULL DEFAULT 'standard' CHECK (variant = 'standard'),
  event          TEXT,
  round          TEXT,
  started_at     INTEGER,
  ended_at       INTEGER,                         -- NULL only for PGN games without a usable date
  ply_count      INTEGER NOT NULL,
  moves_san      TEXT    NOT NULL,                -- mainline SAN, space-separated, no move numbers
  eco            TEXT,
  opening_name   TEXT,
  opening_ply    INTEGER,                         -- deepest ply (<= 40) matching chess-openings
  accuracy_white REAL,
  accuracy_black REAL,
  headers_json   TEXT,                            -- original PGN headers as an object
  UNIQUE (origin, origin_id)
) STRICT;
CREATE INDEX games_database ON games (database_id, ended_at) WHERE database_id IS NOT NULL;
CREATE INDEX games_white_key ON games (white_key);
CREATE INDEX games_black_key ON games (black_key);
CREATE INDEX games_white_fide ON games (white_fide_id) WHERE white_fide_id IS NOT NULL;
CREATE INDEX games_black_fide ON games (black_fide_id) WHERE black_fide_id IS NOT NULL;
CREATE INDEX games_ended ON games (ended_at);

-- One row per (source, game) from that player's side: the table the stats query.
-- ended_at, time_class and rated are copied from games so filters need no join.
CREATE TABLE player_games (
  source_id       INTEGER NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
  game_id         INTEGER NOT NULL REFERENCES games (id) ON DELETE CASCADE,
  color           TEXT    NOT NULL CHECK (color IN ('w', 'b')),
  outcome         TEXT    NOT NULL CHECK (outcome IN ('w', 'd', 'l')),
  rating          INTEGER,                        -- the player's pre-game rating
  rating_after    INTEGER,
  opp_name        TEXT    NOT NULL,
  opp_key         TEXT    NOT NULL,               -- playerKey(opp_name)
  opp_rating      INTEGER,
  opp_title       TEXT,
  opp_source_kind TEXT    NOT NULL CHECK (opp_source_kind IN ('lichess', 'chesscom', 'fide', 'pgn')),
  ended_at        INTEGER,
  time_class      TEXT    NOT NULL CHECK (time_class IN (
                    'bullet', 'blitz', 'rapid', 'classical', 'correspondence', 'unknown')),
  rated           INTEGER NOT NULL CHECK (rated IN (0, 1)),
  PRIMARY KEY (source_id, game_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX player_games_source_ended ON player_games (source_id, ended_at);
CREATE INDEX player_games_source_tc ON player_games (source_id, time_class, ended_at);
CREATE INDEX player_games_source_opp ON player_games (source_id, opp_key);
CREATE INDEX player_games_game ON player_games (game_id);
CREATE INDEX player_games_opp ON player_games (opp_source_kind, opp_key);

-- Positions of the first 50 plies of every game, for the position-keyed explorer.
-- ply = half-moves played before this position (0 = initial position, up to 50).
-- pos_key = first 53 bits of SHA-1(chessops EPD) (src/chess/posKey.ts), so transpositions merge.
-- next_uci = the move played from here in standard castling notation (e1g1); NULL when none.
CREATE TABLE positions (
  game_id  INTEGER NOT NULL REFERENCES games (id) ON DELETE CASCADE,
  ply      INTEGER NOT NULL CHECK (ply BETWEEN 0 AND 50),
  pos_key  INTEGER NOT NULL,
  next_uci TEXT,
  PRIMARY KEY (game_id, ply)
) STRICT, WITHOUT ROWID;
CREATE INDEX positions_key ON positions (pos_key, game_id);

-- Opponent country / title for the world map and opponent badges.
-- fetched_at NULL = queued for lookup.
CREATE TABLE players_cache (
  kind       TEXT NOT NULL CHECK (kind IN ('lichess', 'chesscom', 'fide', 'pgn')),
  key        TEXT NOT NULL,
  country    TEXT,                                -- ISO 3166-1 alpha-2, NULL = unknown / none
  title      TEXT,
  name       TEXT,
  fetched_at INTEGER,
  PRIMARY KEY (kind, key)
) STRICT, WITHOUT ROWID;
CREATE INDEX players_cache_pending ON players_cache (kind, fetched_at);

-- ---------------------------------------------------------------------------
-- Studio files (PLAN §8.4)
-- ---------------------------------------------------------------------------

CREATE TABLE files (
  id            INTEGER PRIMARY KEY,
  owner_user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  folder        TEXT    NOT NULL DEFAULT '',      -- slash-separated path, '' = root
  name          TEXT    NOT NULL,
  kind          TEXT    NOT NULL CHECK (kind IN ('study', 'repertoire')),
  color         TEXT    CHECK (color IN ('white', 'black')),
  pgn           TEXT    NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  deleted_at    INTEGER                           -- set = in the recycle bin
) STRICT;
CREATE INDEX files_owner_folder ON files (owner_user_id, folder, name);
CREATE INDEX files_owner_deleted ON files (owner_user_id, deleted_at);

-- ---------------------------------------------------------------------------
-- Jobs (PLAN §7)
-- ---------------------------------------------------------------------------

-- Higher priority runs first; ties run oldest first. `lane` picks the worker
-- (one request in flight per upstream site). `run_after` delays retries/backoff.
-- At most one queued/running job per dedupe_key.
CREATE TABLE jobs (
  id            INTEGER PRIMARY KEY,
  kind          TEXT    NOT NULL,                 -- JobKind (shared/src/api.ts)
  lane          TEXT    NOT NULL CHECK (lane IN ('lichess', 'chesscom', 'local')),
  payload_json  TEXT    NOT NULL DEFAULT '{}',
  status        TEXT    NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'error', 'cancelled')),
  priority      INTEGER NOT NULL DEFAULT 0,
  user_id       INTEGER REFERENCES users (id) ON DELETE SET NULL,
  progress_json TEXT,
  error         TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  run_after     INTEGER,
  created_at    INTEGER NOT NULL,
  started_at    INTEGER,
  finished_at   INTEGER,
  dedupe_key    TEXT
) STRICT;
CREATE INDEX jobs_queue ON jobs (status, priority DESC, created_at);
CREATE INDEX jobs_lane_queue ON jobs (lane, status, priority DESC, created_at);
CREATE INDEX jobs_user ON jobs (user_id, status);
CREATE UNIQUE INDEX jobs_dedupe_active ON jobs (dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running');

-- ---------------------------------------------------------------------------
-- Upstream response cache (Lichess explorer, masters, tablebase, ...)
-- ---------------------------------------------------------------------------

CREATE TABLE http_cache (
  key          TEXT    PRIMARY KEY,               -- normalised upstream URL (+ auth scope if relevant)
  body         ANY     NOT NULL,                  -- TEXT or BLOB
  content_type TEXT    NOT NULL,
  fetched_at   INTEGER NOT NULL,
  etag         TEXT
) STRICT;
CREATE INDEX http_cache_fetched ON http_cache (fetched_at);

-- ---------------------------------------------------------------------------
-- Prep (PLAN §5 Tournament preparation)
-- ---------------------------------------------------------------------------

CREATE TABLE prep_sets (
  id            INTEGER PRIMARY KEY,
  owner_user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name          TEXT    NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
) STRICT;
CREATE INDEX prep_sets_owner ON prep_sets (owner_user_id);

CREATE TABLE prep_opponents (
  prep_id    INTEGER NOT NULL REFERENCES prep_sets (id) ON DELETE CASCADE,
  profile_id INTEGER NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  position   INTEGER NOT NULL DEFAULT 0,          -- display order
  PRIMARY KEY (prep_id, profile_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX prep_opponents_profile ON prep_opponents (profile_id);
