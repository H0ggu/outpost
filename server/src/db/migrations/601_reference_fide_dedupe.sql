-- 601_reference_fide_dedupe: FIDE profiles read reference games only, once per game; monthly dumps
-- correct earlier round imports; auto-import bookkeeping (docs/PLAN.md §5; owner: reference).
--
-- A reference game is "the same game" in two reference databases when its origin_id hash part
-- (games.origin_id = '<databaseId>:<hash>', chess/pgn.ts pgnOriginId) is equal. Lookups below
-- build '<otherDatabaseId>:<hash>' for every other reference database (a handful) and use the
-- UNIQUE (origin, origin_id) index.

-- 1. `player_games` rows of `fide` sources: reference games only (never a user's PGN database,
--    whose WhiteFideId/BlackFideId tags would otherwise put private games on a possibly public
--    FIDE profile), and one copy per game when several reference databases hold it (e.g. the
--    Lichess broadcasts plus a licensed OTB database). Applies to every writer (insertGame's
--    source matching, rebuildPlayerGames, syncs): the insert is skipped (RAISE(IGNORE), no error).
DELETE FROM player_games
 WHERE source_id IN (SELECT id FROM sources WHERE kind = 'fide')
   AND game_id IN (SELECT id FROM games WHERE origin <> 'reference');

DELETE FROM player_games AS pg
 WHERE pg.source_id IN (SELECT id FROM sources WHERE kind = 'fide')
   AND EXISTS (
     SELECT 1 FROM games g
       JOIN databases d ON d.kind = 'reference' AND d.id IS NOT g.database_id
       JOIN games o ON o.origin = 'reference' AND o.origin_id = d.id || substr(g.origin_id, instr(g.origin_id, ':')) AND o.id < g.id
       JOIN player_games p2 ON p2.source_id = pg.source_id AND p2.game_id = o.id
      WHERE g.id = pg.game_id AND g.origin = 'reference');

CREATE TRIGGER reference_fide_player_games BEFORE INSERT ON player_games
  WHEN (SELECT kind FROM sources WHERE id = NEW.source_id) = 'fide'
   AND (
     (SELECT origin FROM games WHERE id = NEW.game_id) IS NOT 'reference'
     OR EXISTS (
       SELECT 1 FROM games g
         JOIN databases d ON d.kind = 'reference' AND d.id IS NOT g.database_id
         JOIN games o ON o.origin = 'reference' AND o.origin_id = d.id || substr(g.origin_id, instr(g.origin_id, ':'))
         JOIN player_games p2 ON p2.source_id = NEW.source_id AND p2.game_id = o.id
        WHERE g.id = NEW.game_id)
   )
BEGIN
  SELECT RAISE(IGNORE);
END;

-- 2. The player index counts a FIDE player's game once across reference databases (the importer
--    skips the FIDE row for a copy of a game another reference database holds), so a deleted copy
--    only counts down when no other copy is left. Name-only rows are per database (unchanged).
DROP TRIGGER reference_players_game_deleted;
CREATE TRIGGER reference_players_game_deleted AFTER DELETE ON games WHEN old.origin = 'reference'
BEGIN
  UPDATE reference_players SET games = MAX(games - 1, 0)
   WHERE fide_id = old.white_fide_id
     AND NOT EXISTS (
       SELECT 1 FROM databases d
         JOIN games o ON o.origin = 'reference' AND o.origin_id = d.id || substr(old.origin_id, instr(old.origin_id, ':'))
        WHERE d.kind = 'reference' AND d.id IS NOT old.database_id);
  UPDATE reference_players SET games = MAX(games - 1, 0)
   WHERE fide_id = old.black_fide_id
     AND NOT EXISTS (
       SELECT 1 FROM databases d
         JOIN games o ON o.origin = 'reference' AND o.origin_id = d.id || substr(old.origin_id, instr(old.origin_id, ':'))
        WHERE d.kind = 'reference' AND d.id IS NOT old.database_id);
  UPDATE reference_players SET games = MAX(games - 1, 0)
   WHERE old.white_fide_id IS NULL AND fide_id IS NULL AND database_id = old.database_id AND name_key = old.white_key;
  UPDATE reference_players SET games = MAX(games - 1, 0)
   WHERE old.black_fide_id IS NULL AND fide_id IS NULL AND database_id = old.database_id AND name_key = old.black_key;
END;

-- 3. Which import stored a broadcast chapter: 0 = a round import or a PGN file, YYYYMM = that
--    monthly dump. A later dump (higher rank) replaces the stored game when its moves, result,
--    players or ratings were corrected in between; equal or lower ranks are duplicates.
ALTER TABLE reference_broadcast_games ADD COLUMN rank INTEGER NOT NULL DEFAULT 0;

-- 4. Auto-import: the last state seen of each official tour (src/reference/autoImport.ts), so a
--    tour's round list is fetched again only when Lichess shows a change (or once a day).
CREATE TABLE reference_broadcast_tours (
  database_id INTEGER NOT NULL REFERENCES databases (id) ON DELETE CASCADE,
  tour_id     TEXT    NOT NULL,
  signature   TEXT    NOT NULL,
  checked_at  INTEGER NOT NULL,
  PRIMARY KEY (database_id, tour_id)
) STRICT, WITHOUT ROWID;
