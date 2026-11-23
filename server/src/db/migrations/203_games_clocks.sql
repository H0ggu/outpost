-- 203_games_clocks: clock times of synced and PGN-database games (owner: jobs).
--
-- `games.clocks`: the time left on the mover's clock after each ply, in centiseconds, comma
-- separated (an empty field where a ply has none); null when the game has no clock data.
-- Lichess games (`clocks=true` in the export), Chess.com games and user PGN databases (`[%clk]`
-- comments) carry them; the PGN writers put them back as `{ [%clk h:mm:ss] }` after each move, so
-- the Studio and exports show them. Reference databases don't store them (their size).
ALTER TABLE games ADD COLUMN clocks TEXT;
