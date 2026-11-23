-- 204_chesscom_reported_ratings: a Chess.com game row keeps both ratings as Chess.com reports
-- them (owner: jobs).
--
-- Chess.com reports post-game ratings. The importer derives the archive owner's pre-game rating
-- for `player_games.rating` (PLAN §7) but also wrote it into `games.white_rating` /
-- `black_rating`, next to the opponent's post-game rating: one side pre-game, the other
-- post-game, depending on whose archive stored the game first, and a PGN export that disagreed
-- with Chess.com's own. The game row now keeps Chess.com's numbers (its PGN's WhiteElo /
-- BlackElo, stored in headers_json); player_games keeps the derived pre-game rating.
UPDATE games SET white_rating = CAST(json_extract(headers_json, '$.WhiteElo') AS INTEGER)
 WHERE origin = 'chesscom' AND json_extract(headers_json, '$.WhiteElo') GLOB '[1-9][0-9]*'
   AND json_extract(headers_json, '$.WhiteElo') NOT GLOB '*[^0-9]*';
UPDATE games SET black_rating = CAST(json_extract(headers_json, '$.BlackElo') AS INTEGER)
 WHERE origin = 'chesscom' AND json_extract(headers_json, '$.BlackElo') GLOB '[1-9][0-9]*'
   AND json_extract(headers_json, '$.BlackElo') NOT GLOB '*[^0-9]*';
