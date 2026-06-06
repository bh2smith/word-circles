-- Dune: https://dune.com/queries/7647942
-- Word Circles PvP - Player Leaderboard (record: played / won / lost / profit)
-- All-time per-player PvP record, derived purely from on-chain escrow events.
--   • Every participant emits a Joined event, so joins = games entered.
--   • Each entry stakes the game's `amount` (read from the matching Created).
--   • Resolved carries winners[]/amounts[]. cardinality(winners) splits outcome:
--       in winners[] & 1 winner   -> WIN  (took the whole pot)
--       in winners[] & 2 winners  -> DRAW (split pot; lobbies are 2-player)
--       not in winners[]          -> LOSS
--   • won_crc zips winners[] with amounts[] so each winner gets the CRC they got.
--
-- Counts/profit are over RESOLVED games only — an unsettled game's stake is still
-- escrowed, neither won nor lost. net_crc = won_crc - staked_crc is the player's
-- profit (+/-); it already nets the stake, so it stays correct once a protocol
-- rake is turned on (the rake just shrinks future payouts).
--
-- Player names use the same hybrid resolution as the daily-Wordle boards
-- (see 01_daily_leaderboard.sql): the uploaded CSV
-- (dune.bh2smith.dataset_word_circles_player_names, address varbinary -> name)
-- covers the bulk, then a live http_post to rpc.aboutcircles.com names ONLY the
-- players the CSV missed. Scoping the live calls to that unresolved few stays
-- under Dune's per-execution HTTP request cap. Refresh the bulk names by
-- re-running ../scripts/build_circles_names.py and re-uploading the CSV.
--
-- The escrow decoded tables live under word_circles_gnosis (see the header of
-- 04_pvp_game_lifecycle.sql for the contract addresses). Circles tokens are
-- 18-decimal; wei amounts are scaled to whole CRC.

WITH game_stake AS (
  SELECT gameId, CAST(amount AS double) AS stake_wei, capacity
  FROM word_circles_gnosis.wordcirclesescrow_evt_created
),
-- Resolved games + winners[]; cardinality distinguishes an outright win
-- (1 winner) from a split/draw (2 winners in a 2-player lobby).
resolved_detail AS (
  SELECT gameId, winners, cardinality(winners) AS winner_count
  FROM word_circles_gnosis.wordcirclesescrow_evt_resolved
),
-- One row per (game, participant); classify the realized outcome.
entries AS (
  SELECT
    j.player,
    gs.stake_wei,
    rd.gameId IS NOT NULL AS is_resolved,
    CASE
      WHEN rd.gameId IS NULL                                      THEN NULL      -- unsettled
      WHEN contains(rd.winners, j.player) AND rd.winner_count = 1 THEN 'win'
      WHEN contains(rd.winners, j.player)                        THEN 'draw'    -- split pot
      ELSE 'loss'
    END AS outcome
  FROM word_circles_gnosis.wordcirclesescrow_evt_joined j
  JOIN game_stake        gs ON gs.gameId = j.gameId
  LEFT JOIN resolved_detail rd ON rd.gameId = j.gameId
),
entry_aggs AS (
  SELECT
    player,
    COUNT(*)                                          AS games_entered,
    COUNT(*) FILTER (WHERE is_resolved)               AS games_resolved,
    COUNT(*) FILTER (WHERE outcome = 'win')           AS wins,
    COUNT(*) FILTER (WHERE outcome = 'loss')          AS losses,
    COUNT(*) FILTER (WHERE outcome = 'draw')          AS draws,
    SUM(stake_wei) FILTER (WHERE is_resolved)         AS staked_resolved_wei
  FROM entries
  GROUP BY player
),
-- Payouts: zip winners[] with amounts[] element-wise -> CRC received per player.
payouts AS (
  SELECT
    winner          AS player,
    SUM(amt)        AS won_wei
  FROM word_circles_gnosis.wordcirclesescrow_evt_resolved
  CROSS JOIN UNNEST(winners, amounts) AS t(winner, amt)
  GROUP BY winner
),
player_profiles AS (
  -- Uploaded CSV table: columns (player varbinary address, name varchar)
  SELECT player AS player_addr, name AS circles_name
  FROM dune.bh2smith.dataset_word_circles_player_names
),
-- Players the CSV did not name; resolved live below.
unresolved_players AS (
  SELECT DISTINCT ea.player AS player_addr
  FROM entry_aggs ea
  LEFT JOIN player_profiles pp ON pp.player_addr = ea.player
  WHERE NULLIF(pp.circles_name, '') IS NULL
),
-- Live fallback: one http_post per unresolved player (kept small so we stay
-- under Dune's per-execution HTTP request cap).
live_profiles AS (
  SELECT
    player_addr,
    json_value(
      http_post(
        'https://rpc.aboutcircles.com/',
        '{"jsonrpc":"2.0","id":1,"method":"circles_getProfileByAddress","params":["0x' || to_hex(player_addr) || '"]}',
        ARRAY['Content-Type: application/json']
      ),
      'lax $.result.name'
    ) AS circles_name
  FROM unresolved_players
)
SELECT
  COALESCE(
    NULLIF(pp.circles_name, ''),
    NULLIF(lp.circles_name, ''),
    '0x' || substr(to_hex(ea.player), 1, 4) || '…' || substr(to_hex(ea.player), -4)
  )                                                                       AS player_name,
  ea.player,
  ea.games_entered,
  ea.games_resolved,
  ea.wins,
  ea.losses,
  ea.draws,
  ROUND(100.0 * ea.wins / NULLIF(ea.games_resolved, 0), 1)               AS win_rate_pct,
  ROUND(COALESCE(CAST(ea.staked_resolved_wei AS double), 0) / 1e18, 3)    AS staked_crc,
  ROUND(COALESCE(CAST(po.won_wei AS double), 0) / 1e18, 3)               AS won_crc,
  -- Net profit (+/-): CRC won minus CRC staked over resolved games.
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
LEFT JOIN live_profiles   lp ON lp.player_addr = ea.player
ORDER BY
  net_crc DESC,
  win_rate_pct DESC NULLS LAST,
  games_resolved DESC
