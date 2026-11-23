-- 300_stats_indexes: indexes for the profile statistics queries (owner: stats, PLAN §6 "Stats").
--
-- The stats endpoints aggregate a profile's player_games rows joined to games for the
-- termination, game length and opening columns. Read through the wide games rows (moves and
-- headers), a 100k-game profile pulls ~45 MB of pages; this covering index holds just those
-- columns (~7 MB per 100k games), so a cold cache costs a tenth of the I/O. The queries name it
-- with INDEXED BY (src/stats/common.ts: GAMES_STATS_INDEX), so the plan does not depend on
-- whether sqlite_stat1 exists.
CREATE INDEX games_stats ON games (id, termination, ply_count, opening_ply, eco, opening_name);
