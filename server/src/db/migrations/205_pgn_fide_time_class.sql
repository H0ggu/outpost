-- 205_pgn_fide_time_class: over-the-board PGN games use the FIDE rule wherever they are stored
-- (owner: jobs; docs/DECISIONS.md R8).
--
-- User PGN databases (and reference imports other than Lichess broadcasts) classified a
-- TimeControl with Lichess's online thresholds (base + 40 × increment) while broadcast games used
-- the FIDE rule (base + 60 × increment: under 3 min bullet, up to 10 min blitz, under 60 min
-- rapid, else classical), so `1800` or `2700+10` was classical in one database and rapid in
-- another. chess/pgn.ts now applies the FIDE rule to every PGN game not played on Lichess or
-- Chess.com; this reclassifies the stored ones with a plain `N` / `N+M` (seconds) TimeControl,
-- and their player_games rows.

CREATE TEMP TABLE otb_time_class AS
  SELECT id, CASE
           WHEN t < 180 THEN 'bullet'
           WHEN t <= 600 THEN 'blitz'
           WHEN t < 3600 THEN 'rapid'
           ELSE 'classical'
         END AS time_class
    FROM (
      SELECT id,
             CASE WHEN instr(time_control, '+') > 0
                  THEN CAST(substr(time_control, 1, instr(time_control, '+') - 1) AS INTEGER)
                       + 60 * CAST(substr(time_control, instr(time_control, '+') + 1) AS INTEGER)
                  ELSE CAST(time_control AS INTEGER) END AS t,
             time_class AS old
        FROM games
       WHERE origin IN ('pgn', 'reference')
         AND time_control GLOB '[0-9]*' AND time_control NOT GLOB '*[^0-9+]*' AND time_control NOT GLOB '*+*+*'
         AND time_control NOT GLOB '*+'
         AND NOT (COALESCE(url, '') GLOB 'http*://lichess.org/*'
                  AND COALESCE(url, '') NOT GLOB 'http*://lichess.org/broadcast/*'
                  AND COALESCE(url, '') NOT GLOB 'http*://lichess.org/study/*')
         AND COALESCE(json_extract(headers_json, '$.Site'), '') <> 'Chess.com'
         AND COALESCE(json_extract(headers_json, '$.Link'), '') NOT LIKE '%chess.com/game/%')
   WHERE t > 0 AND old <> CASE WHEN t < 180 THEN 'bullet' WHEN t <= 600 THEN 'blitz' WHEN t < 3600 THEN 'rapid' ELSE 'classical' END;

UPDATE games SET time_class = (SELECT o.time_class FROM otb_time_class o WHERE o.id = games.id)
 WHERE id IN (SELECT id FROM otb_time_class);

UPDATE player_games SET time_class = (SELECT o.time_class FROM otb_time_class o WHERE o.id = player_games.game_id)
 WHERE game_id IN (SELECT id FROM otb_time_class);

DROP TABLE otb_time_class;
