-- 602_reference_private_fide: a private reference database is admins-only, so it never feeds
-- FIDE players (docs/DECISIONS.md, decision 2 note; owner: reference).
--
-- `fide` sources link games of **public** reference databases only, still one copy per game
-- (migration 601). FIDE profiles and the `ref:<fideId>` explorer are instance-wide data with no
-- per-viewer filtering, so the only way to keep an admin's private (e.g. licensed) database from
-- every other user is to leave it out of them altogether. When an admin changes a reference
-- database's visibility, chess/store.ts `relinkFideSources` drops and re-adds the rows.

DROP TRIGGER reference_fide_player_games;

CREATE TRIGGER reference_fide_player_games BEFORE INSERT ON player_games
  WHEN (SELECT kind FROM sources WHERE id = NEW.source_id) = 'fide'
   AND (
     (SELECT origin FROM games WHERE id = NEW.game_id) IS NOT 'reference'
     OR (SELECT d.visibility FROM games g JOIN databases d ON d.id = g.database_id WHERE g.id = NEW.game_id) IS NOT 'public'
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

-- Rows written before this rule (games of a reference database that is private now).
DELETE FROM player_games AS pg
 WHERE pg.source_id IN (SELECT id FROM sources WHERE kind = 'fide')
   AND (SELECT d.visibility FROM games g JOIN databases d ON d.id = g.database_id WHERE g.id = pg.game_id) IS NOT 'public';
