-- Dune: https://dune.com/queries/7647948
-- Word Circles PvP - Daily Activity & Volume
-- One row per UTC day with the PvP funnel and CRC flow:
--   games_created   lobbies opened
--   players_joined  total entries (every participant emits Joined)
--   games_resolved  games settled on-chain that day
--   stake_volume    CRC staked by joiners that day (per-entry stake)
--   payout_volume   CRC paid out to winners that day
-- Good for an area/bar time series and for spotting fill/settle backlogs
-- (created vs resolved diverging).
--
-- Each event type is bucketed by day independently, then FULL OUTER JOINed on
-- the day so a day with only joins (no new lobby, no settlement) still shows up.
--
-- The escrow decoded tables live under word_circles_gnosis (see the header of
-- 04_pvp_game_lifecycle.sql for the contract addresses). Circles tokens are
-- 18-decimal; wei amounts are scaled to whole CRC.

WITH d_created AS (
  SELECT
    date_trunc('day', evt_block_time)                              AS day,
    COUNT(*)                                                       AS games_created,
    SUM(CAST(amount AS double) * CAST(capacity AS double)) / 1e18  AS pot_opened_crc
  FROM word_circles_gnosis.wordcirclesescrow_evt_created
  GROUP BY 1
),
-- Joins carry no amount, so pull the per-entry stake from the matching Created.
d_joined AS (
  SELECT
    date_trunc('day', j.evt_block_time)         AS day,
    COUNT(*)                                    AS players_joined,
    SUM(CAST(c.amount AS double)) / 1e18        AS stake_volume_crc
  FROM word_circles_gnosis.wordcirclesescrow_evt_joined j
  JOIN word_circles_gnosis.wordcirclesescrow_evt_created c ON c.gameId = j.gameId
  GROUP BY 1
),
d_resolved AS (
  SELECT
    date_trunc('day', evt_block_time)                                       AS day,
    COUNT(*)                                                                AS games_resolved,
    SUM((SELECT SUM(x) FROM UNNEST(amounts) AS u(x))) / 1e18                AS payout_volume_crc
  FROM word_circles_gnosis.wordcirclesescrow_evt_resolved
  GROUP BY 1
)
SELECT
  COALESCE(cr.day, jo.day, re.day)                  AS day,
  COALESCE(cr.games_created, 0)                     AS games_created,
  COALESCE(jo.players_joined, 0)                    AS players_joined,
  COALESCE(re.games_resolved, 0)                    AS games_resolved,
  ROUND(COALESCE(jo.stake_volume_crc, 0), 3)        AS stake_volume_crc,
  ROUND(COALESCE(re.payout_volume_crc, 0), 3)       AS payout_volume_crc,
  ROUND(COALESCE(cr.pot_opened_crc, 0), 3)          AS pot_opened_crc,
  -- Running totals for cumulative-volume charts.
  SUM(COALESCE(jo.stake_volume_crc, 0))
    OVER (ORDER BY COALESCE(cr.day, jo.day, re.day)) AS cumulative_stake_crc,
  SUM(COALESCE(re.games_resolved, 0))
    OVER (ORDER BY COALESCE(cr.day, jo.day, re.day)) AS cumulative_games_resolved
FROM d_created cr
FULL OUTER JOIN d_joined   jo ON jo.day = cr.day
FULL OUTER JOIN d_resolved re ON re.day = COALESCE(cr.day, jo.day)
ORDER BY day DESC
