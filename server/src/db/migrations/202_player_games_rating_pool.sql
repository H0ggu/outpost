-- 202_player_games_rating_pool: Lichess UltraBullet is its own rating pool (owner: jobs).
--
-- Outpost files UltraBullet games under `bullet` (PLAN §7: the time-class filter folds them in),
-- but Lichess rates them separately (e.g. 2406 UltraBullet next to 3263 bullet). Every rating
-- view groups by (source, time class), so one UltraBullet game put a second pool's rating into
-- the bullet chart, the current bullet rating and the rating averages. `rating_pool` names the
-- pool when it is not the time class's own: 'ultraBullet' for Lichess games (synced, or a Lichess
-- PGN export) estimated under 30 s (`initial + 40 × increment`, Lichess's own speed rule).
-- chess/store.ts `ratingPoolOf` sets it for new rows; this backfills the stored ones.

ALTER TABLE player_games ADD COLUMN rating_pool TEXT CHECK (rating_pool IS NULL OR rating_pool = 'ultraBullet');

UPDATE player_games SET rating_pool = 'ultraBullet'
 WHERE time_class = 'bullet'
   AND game_id IN (
     SELECT id FROM games
      WHERE time_class = 'bullet'
        AND (origin = 'lichess' OR url LIKE 'https://lichess.org/%')
        AND time_control GLOB '[0-9]*+[0-9]*'
        AND CAST(substr(time_control, 1, instr(time_control, '+') - 1) AS INTEGER)
            + 40 * CAST(substr(time_control, instr(time_control, '+') + 1) AS INTEGER) < 30);
