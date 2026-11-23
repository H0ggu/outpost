-- 502_fide_reference_only: a `fide` source reads reference-DB games only (PLAN §5 "A FIDE player
-- profile is built from reference-DB games").
--
-- Games in user PGN databases can carry WhiteFideId / BlackFideId tags too. Matching those to a
-- FIDE source would attach games of someone's private database to every (possibly public) profile
-- with that FIDE id: `loadProfileForViewer` checks database visibility for `pgn` sources only. So
-- `player_games` never holds a row of a `fide` source for a game whose origin is not 'reference',
-- whoever writes it (`insertGame`'s source matching, `rebuildPlayerGames`, a sync of the source):
-- such an insert is skipped (RAISE(IGNORE): no error, no row).

DELETE FROM player_games
 WHERE source_id IN (SELECT id FROM sources WHERE kind = 'fide')
   AND game_id IN (SELECT id FROM games WHERE origin <> 'reference');

CREATE TRIGGER player_games_fide_reference_only BEFORE INSERT ON player_games
  WHEN (SELECT kind FROM sources WHERE id = NEW.source_id) = 'fide'
   AND (SELECT origin FROM games WHERE id = NEW.game_id) IS NOT 'reference'
BEGIN
  SELECT RAISE(IGNORE);
END;
