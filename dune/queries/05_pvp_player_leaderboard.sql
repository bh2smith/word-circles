-- Word Circles PvP - Player Leaderboard (stakes, winnings, net P&L)
-- All-time per-player PvP economics, derived purely from on-chain escrow events.
--   • Every participant emits a Joined event, so joins = games entered.
--   • Each entry stakes the game's `amount` (read from the matching Created).
--   • Resolved carries parallel winners[]/amounts[] arrays; UNNEST zips them so
--     each winner is paired with the CRC they received (a split/draw pays both).
--
-- Net P&L is computed over RESOLVED games only — an unsettled game's stake is
-- still escrowed, neither won nor lost — so `staked_crc`/`net_crc` reflect
-- realized outcomes. A "win" here means the player received any payout; on a
-- draw the pot is split, so both players count as paid (see `win_rate_pct`).
--
-- Player names come from the same uploaded CSV
-- (dune.bh2smith.dataset_word_circles_player_names) used by the daily-Wordle
-- boards: address (varbinary) -> Circles profile name. Refresh by re-running
-- ../scripts/build_circles_names.py and re-uploading the CSV.
--
-- NOTE: the escrow decoded tables are not on Dune yet — see the header of
-- 04_pvp_game_lifecycle.sql for the contracts to submit for decoding. Circles
-- tokens are 18-decimal; wei amounts are scaled to whole CRC.

WITH game_stake AS (
  SELECT gameId, CAST(amount AS double) AS stake_wei, capacity
  FROM word_circles_gnosis.wordcirclesescrow_evt_created
),
resolved_games AS (
  SELECT DISTINCT gameId
  FROM word_circles_gnosis.wordcirclesescrow_evt_resolved
),
-- One row per (game, participant); flag whether that game has settled.
entries AS (
  SELECT
    j.player,
    gs.stake_wei,
    rg.gameId IS NOT NULL AS is_resolved
  FROM word_circles_gnosis.wordcirclesescrow_evt_joined j
  JOIN game_stake     gs ON gs.gameId = j.gameId
  LEFT JOIN resolved_games rg ON rg.gameId = j.gameId
),
entry_aggs AS (
  SELECT
    player,
    COUNT(*)                                          AS games_entered,
    COUNT(*) FILTER (WHERE is_resolved)               AS games_resolved,
    SUM(stake_wei) FILTER (WHERE is_resolved)         AS staked_resolved_wei
  FROM entries
  GROUP BY player
),
-- Payouts: zip winners[] with amounts[] element-wise.
payouts AS (
  SELECT
    winner          AS player,
    COUNT(*)        AS games_paid,    -- includes draws (a split still pays)
    SUM(amt)        AS won_wei
  FROM word_circles_gnosis.wordcirclesescrow_evt_resolved
  CROSS JOIN UNNEST(winners, amounts) AS t(winner, amt)
  GROUP BY winner
),
player_profiles AS (
  -- Uploaded CSV table: columns (player varbinary address, name varchar)
  SELECT player AS player_addr, name AS circles_name
  FROM dune.bh2smith.dataset_word_circles_player_names
)
SELECT
  COALESCE(
    NULLIF(pp.circles_name, ''),
    '0x' || substr(to_hex(ea.player), 1, 4) || '…' || substr(to_hex(ea.player), -4)
  )                                                                       AS player_name,
  ea.player,
  ea.games_entered,
  ea.games_resolved,
  COALESCE(po.games_paid, 0)                                              AS games_paid,
  ROUND(100.0 * COALESCE(po.games_paid, 0) / NULLIF(ea.games_resolved, 0), 1) AS win_rate_pct,
  ROUND(COALESCE(CAST(ea.staked_resolved_wei AS double), 0) / 1e18, 3)    AS staked_crc,
  ROUND(COALESCE(CAST(po.won_wei AS double), 0) / 1e18, 3)               AS won_crc,
  ROUND(
    (COALESCE(CAST(po.won_wei AS double), 0)
       - COALESCE(CAST(ea.staked_resolved_wei AS double), 0)) / 1e18,
    3
  )                                                                       AS net_crc,
  -- ROI on staked capital across resolved games.
  ROUND(
    100.0 * (COALESCE(CAST(po.won_wei AS double), 0)
               - COALESCE(CAST(ea.staked_resolved_wei AS double), 0))
      / NULLIF(CAST(ea.staked_resolved_wei AS double), 0),
    1
  )                                                                       AS roi_pct
FROM entry_aggs ea
LEFT JOIN payouts         po ON po.player      = ea.player
LEFT JOIN player_profiles pp ON pp.player_addr = ea.player
ORDER BY
  net_crc DESC,
  win_rate_pct DESC NULLS LAST,
  games_resolved DESC
