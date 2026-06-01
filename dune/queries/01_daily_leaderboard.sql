-- Word Circles - Daily Leaderboard (current puzzle)
-- Ranks every submission for the latest gameId.
-- Order:
--   1. Wins before losses
--   2. Fewer guesses first
--   3. Earlier block_time wins ties (classic Wordle tiebreaker)
-- The "latest" puzzle is whichever gameId is currently the max in the table,
-- so the board auto-rolls each day without a parameter.
--
-- Player names are read from an uploaded CSV table
-- (dune.bh2smith.dataset_word_circles_player_names) mapping address (varbinary)
-- -> Circles profile name. Dune's CSV upload infers the 0x-hex `player` column
-- as varbinary, so it joins directly against the on-chain `player`. Previously
-- these were resolved live via http_post to rpc.aboutcircles.com (one request
-- per player), which can trip Dune's per-execution HTTP request cap. To refresh
-- names, re-run the offline resolver (../scripts/build_circles_names.py) and
-- re-upload the CSV.

WITH latest AS (
  SELECT MAX(gameId) AS gid
  FROM word_circles_gnosis.wordcirclestats_evt_gamerecorded
),
day_games AS (
  SELECT
    player,
    gameId,
    guesses,
    won,
    evt_block_time                                                                    AS submitted_at,
    date_diff('second', date_trunc('day', evt_block_time), evt_block_time)            AS seconds_from_utc_midnight,
    evt_tx_hash
  FROM word_circles_gnosis.wordcirclestats_evt_gamerecorded
  WHERE gameId = (SELECT gid FROM latest)
),
ranked AS (
  SELECT
    *,
    ROW_NUMBER() OVER (
      ORDER BY
        CASE WHEN won THEN 0 ELSE 1 END,
        guesses ASC,
        submitted_at ASC
    ) AS place
  FROM day_games
),
player_profiles AS (
  -- Uploaded CSV table: columns (player varbinary address, name varchar)
  SELECT
    player AS player_addr,
    name   AS circles_name
  FROM dune.bh2smith.dataset_word_circles_player_names
)
SELECT
  r.place,
  COALESCE(
    NULLIF(p.circles_name, ''),
    '0x' || substr(to_hex(r.player), 1, 4) || '…' || substr(to_hex(r.player), -4)
  )                                                 AS player_name,
  r.player,
  r.gameId                                          AS game_id,
  r.guesses,
  r.won,
  r.submitted_at,
  ROUND(r.seconds_from_utc_midnight / 60.0, 1)      AS minutes_from_utc_midnight,
  r.evt_tx_hash                                     AS tx_hash
FROM ranked r
LEFT JOIN player_profiles p ON p.player_addr = r.player
ORDER BY r.place ASC
