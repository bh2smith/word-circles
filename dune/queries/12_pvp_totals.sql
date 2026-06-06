-- Dune: https://dune.com/queries/7665840
-- Word Circles PvP — Headline Totals
-- Single-row all-time PvP aggregates for dashboard counters.
--   total_volume_crc   gross CRC staked across every entry (each Joined stakes
--                      the game's per-player `amount`, read from Created)
--   settled_volume_crc the same restricted to RESOLVED games (realized)
--   total_payout_crc   CRC paid out to winners over resolved games
-- Aggregate net PnL is ~zero-sum (total_payout - settled_volume = -rake, and
-- rake is 0 today), so the meaningful PnL view is per-player in
-- 05_pvp_player_leaderboard.sql (net_crc); this query is the throughput headline.
-- Escrow decoded tables: word_circles_gnosis (see 04_pvp_game_lifecycle.sql).
-- Circles tokens are 18-decimal; wei are scaled to whole CRC.
WITH created AS (
  SELECT gameId, CAST(amount AS double) AS stake_wei
  FROM word_circles_gnosis.wordcirclesescrow_evt_created
),
resolved_games AS (
  SELECT DISTINCT gameId FROM word_circles_gnosis.wordcirclesescrow_evt_resolved
),
entries AS (
  SELECT
    j.player,
    j.gameId,
    c.stake_wei,
    rg.gameId IS NOT NULL AS is_resolved
  FROM word_circles_gnosis.wordcirclesescrow_evt_joined j
  JOIN created c          ON c.gameId  = j.gameId
  LEFT JOIN resolved_games rg ON rg.gameId = j.gameId
),
payouts AS (
  SELECT SUM(amt) AS won_wei
  FROM word_circles_gnosis.wordcirclesescrow_evt_resolved
  CROSS JOIN UNNEST(amounts) AS t(amt)
)
SELECT
  COUNT(DISTINCT e.gameId)                                          AS games_entered,
  COUNT(DISTINCT e.gameId) FILTER (WHERE e.is_resolved)             AS games_resolved,
  COUNT(*)                                                          AS total_entries,
  COUNT(DISTINCT e.player)                                          AS unique_players,
  ROUND(SUM(e.stake_wei) / 1e18, 3)                                 AS total_volume_crc,
  ROUND(SUM(e.stake_wei) FILTER (WHERE e.is_resolved) / 1e18, 3)    AS settled_volume_crc,
  ROUND((SELECT won_wei FROM payouts) / 1e18, 3)                    AS total_payout_crc
FROM entries e
