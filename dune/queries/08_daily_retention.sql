-- Dune: https://dune.com/queries/7662928
-- Word Circles — Daily Retention
-- Engagement per daily puzzle (gameId is the puzzle number, one per day):
--   active_players          distinct players who submitted that puzzle
--   new_players             first puzzle they ever played
--   returning_players       had played some earlier puzzle
--   returning_rate_pct      returning / active
--   retained_from_prev_day  also played the immediately previous puzzle (sticky)
--   next_day_retention_pct  share of today's players who play the NEXT puzzle
--                           (NULL for the latest puzzle — no next day yet)
--
-- "Consecutive" is by gameId (the puzzle index), so a gap in gameId correctly
-- counts as a missed day.
WITH pg AS (
  SELECT player, gameId, MIN(evt_block_time) AS first_block
  FROM word_circles_gnosis.wordcirclestats_evt_gamerecorded
  GROUP BY player, gameId
),
firsts AS (
  SELECT player, MIN(gameId) AS first_game FROM pg GROUP BY player
),
day_time AS (
  SELECT gameId, date_trunc('day', MIN(first_block)) AS game_date FROM pg GROUP BY gameId
),
span AS (
  SELECT MAX(gameId) AS max_game FROM pg
),
flags AS (
  SELECT
    pg.gameId,
    pg.player,
    (pg.gameId = f.first_game) AS is_new,
    EXISTS (SELECT 1 FROM pg p WHERE p.player = pg.player AND p.gameId = pg.gameId - 1) AS played_prev,
    EXISTS (SELECT 1 FROM pg p WHERE p.player = pg.player AND p.gameId = pg.gameId + 1) AS plays_next
  FROM pg JOIN firsts f ON f.player = pg.player
)
SELECT
  fl.gameId AS game_id,
  dt.game_date,
  COUNT(*)                                                                      AS active_players,
  COUNT(*) FILTER (WHERE is_new)                                                AS new_players,
  COUNT(*) FILTER (WHERE NOT is_new)                                            AS returning_players,
  ROUND(100.0 * COUNT(*) FILTER (WHERE NOT is_new) / NULLIF(COUNT(*), 0), 1)    AS returning_rate_pct,
  COUNT(*) FILTER (WHERE played_prev)                                           AS retained_from_prev_day,
  CASE WHEN fl.gameId = sp.max_game THEN NULL
       ELSE ROUND(100.0 * COUNT(*) FILTER (WHERE plays_next) / NULLIF(COUNT(*), 0), 1)
  END                                                                          AS next_day_retention_pct
FROM flags fl
JOIN day_time dt ON dt.gameId = fl.gameId
CROSS JOIN span sp
GROUP BY fl.gameId, dt.game_date, sp.max_game
ORDER BY fl.gameId
