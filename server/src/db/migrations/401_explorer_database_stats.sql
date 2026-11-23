-- 401_explorer_database_stats: what the local explorers need to answer from large databases
-- (explorer module, PLAN §6; src/explorer/gameSet.ts, src/explorer/query.ts).
--
-- 1. explorer_db_stats: per-database game count and change counter, kept by triggers on `games`.
--    The explorers key their result caches on a database's own counter, so syncing a profile or
--    importing into another database doesn't evict a reference database's cached answers, and they
--    use the count to choose a query plan. No foreign key: a deleted database's games are deleted
--    (counter updated) before the row would go, and a reused id keeps a monotonic counter.
-- 2. games_explorer_db: a covering index over a database's games in id order with every column
--    the explorers aggregate (result, ratings, date, speed, rated), so walking a reference database
--    or looking a game up in it never reads the wide `games` rows (moves, headers).

CREATE TABLE explorer_db_stats (
  database_id INTEGER PRIMARY KEY,
  games       INTEGER NOT NULL DEFAULT 0,
  changes     INTEGER NOT NULL DEFAULT 0
) STRICT;

INSERT INTO explorer_db_stats (database_id, games, changes)
  SELECT database_id, count(*), count(*) FROM games WHERE database_id IS NOT NULL GROUP BY database_id;

CREATE TRIGGER explorer_db_stats_insert AFTER INSERT ON games
  WHEN NEW.database_id IS NOT NULL
BEGIN
  INSERT INTO explorer_db_stats (database_id, games, changes) VALUES (NEW.database_id, 1, 1)
    ON CONFLICT (database_id) DO UPDATE SET games = games + 1, changes = changes + 1;
END;

CREATE TRIGGER explorer_db_stats_delete AFTER DELETE ON games
  WHEN OLD.database_id IS NOT NULL
BEGIN
  UPDATE explorer_db_stats SET games = games - 1, changes = changes + 1 WHERE database_id = OLD.database_id;
END;

CREATE TRIGGER explorer_db_stats_update AFTER UPDATE ON games
  WHEN OLD.database_id IS NOT NULL OR NEW.database_id IS NOT NULL
BEGIN
  UPDATE explorer_db_stats
     SET games = games - (OLD.database_id IS NOT NEW.database_id), changes = changes + 1
   WHERE database_id = OLD.database_id;
  INSERT INTO explorer_db_stats (database_id, games, changes)
    SELECT NEW.database_id, 1, 1 WHERE NEW.database_id IS NOT NULL AND NEW.database_id IS NOT OLD.database_id
    ON CONFLICT (database_id) DO UPDATE SET games = games + 1, changes = changes + 1;
END;

CREATE INDEX games_explorer_db ON games (database_id, id, result, white_rating, black_rating, ended_at, time_class, rated)
  WHERE database_id IS NOT NULL;
