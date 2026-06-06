-- Dune: https://dune.com/queries/7665765
-- Word Circles PvP — Revenue (resolver rake)
-- "Revenue" = the pot remainder WordCirclesEscrow keeps back from each settled
-- game and pays to the game's resolver (the backend signer). In resolve():
--   pot       = stake * capacity
--   payout    = SUM(winner amounts)
--   remainder = pot - payout   -> transferred to game.resolver  (the take)
-- Only RESOLVED games contribute; open/unsettled lobbies hold escrowed stake,
-- not revenue. One row per UTC day (bucketed on resolve time) with daily and
-- cumulative revenue — the latest cumulative_revenue_crc is the all-time total.
--
-- NOTE: revenue reads 0 while the resolver pays the full pot out to winners
-- (remainder == 0 every game). It populates automatically the day a fee/rake is
-- introduced; until then take_rate_pct stays 0 and this is a 0-baseline counter.
--
-- Escrow decoded tables live under word_circles_gnosis (see 04_pvp_game_lifecycle.sql
-- for contract addresses). Circles tokens are 18-decimal; wei are scaled to whole CRC.
WITH created AS (
  SELECT gameId,
         CAST(amount AS double) * CAST(capacity AS double) AS pot_wei
  FROM word_circles_gnosis.wordcirclesescrow_evt_created
),
resolved AS (
  SELECT gameId, evt_block_time AS resolved_at,
         (SELECT SUM(x) FROM UNNEST(amounts) AS u(x)) AS payout_wei
  FROM word_circles_gnosis.wordcirclesescrow_evt_resolved
),
game_rev AS (
  SELECT
    r.resolved_at,
    c.pot_wei,
    r.payout_wei,
    c.pot_wei - r.payout_wei AS revenue_wei
  FROM resolved r
  JOIN created c ON c.gameId = r.gameId
),
daily AS (
  SELECT
    date_trunc('day', resolved_at) AS day,
    COUNT(*)                       AS games_resolved,
    SUM(pot_wei)     / 1e18        AS pot_crc,
    SUM(payout_wei)  / 1e18        AS payout_crc,
    SUM(revenue_wei) / 1e18        AS revenue_crc
  FROM game_rev
  GROUP BY 1
)
SELECT
  day,
  games_resolved,
  ROUND(pot_crc, 3)                                  AS pot_crc,
  ROUND(payout_crc, 3)                               AS payout_crc,
  ROUND(revenue_crc, 3)                              AS revenue_crc,
  ROUND(SUM(revenue_crc) OVER (ORDER BY day), 3)     AS cumulative_revenue_crc,
  ROUND(100.0 * revenue_crc / NULLIF(pot_crc, 0), 2) AS take_rate_pct
FROM daily
ORDER BY day DESC
