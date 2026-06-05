-- Dune: https://dune.com/queries/7608035
-- Word Circles - Daily Leaderboard (current puzzle)
-- Ranks every submission for the latest gameId.
-- Order:
--   1. Wins before losses
--   2. Fewer guesses first
--   3. Earlier block_time wins ties (classic Wordle tiebreaker)
-- The "latest" puzzle is whichever gameId is currently the max in the table,
-- so the board auto-rolls each day without a parameter.
--
-- Name resolution (hybrid: uploaded CSV first, live fallback for the rest):
--   1. player_profiles    — uploaded CSV table
--        (dune.bh2smith.dataset_word_circles_player_names) mapping the 0x-hex
--        `player` (Dune infers it as varbinary, so it joins directly) -> name.
--   2. unresolved_players — the players the CSV did NOT cover (null/empty name).
--   3. live_profiles      — ONLY for those unresolved players, http_post to
--        rpc.aboutcircles.com (circles_getProfileByAddress) and pluck
--        $.result.name. Scoping the live calls to the unresolved few keeps us
--        under Dune's per-execution HTTP request cap (the reason the all-live
--        approach was abandoned) while still naming brand-new players.
-- Final name = CSV name, else live name, else the raw 0x address.
-- Refresh the bulk names by re-running ../scripts/build_circles_names.py and
-- re-uploading the CSV.

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
    evt_block_time AS submitted_at,
    date_diff('second', date_trunc('day', evt_block_time), evt_block_time) AS seconds_from_utc_midnight,
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
  SELECT
    player AS player_addr,
    name AS circles_name
  FROM dune.bh2smith.dataset_word_circles_player_names
),

unresolved_players AS (
  SELECT DISTINCT
    r.player AS player_addr
  FROM ranked r
  LEFT JOIN player_profiles p
    ON p.player_addr = r.player
  WHERE NULLIF(p.circles_name, '') IS NULL
),

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
  r.place,
  COALESCE(
    NULLIF(p.circles_name, ''),
    NULLIF(l.circles_name, ''),
    concat('0x', to_hex(r.player))
  ) AS player_name,
  r.gameId AS game_id,
  r.guesses,
  r.won,
  r.submitted_at,
  ROUND(r.seconds_from_utc_midnight / (60.0 * 60.0), 1) AS hours_from_utc_midnight,
  r.evt_tx_hash AS tx_hash
FROM ranked r
LEFT JOIN player_profiles p
  ON p.player_addr = r.player
LEFT JOIN live_profiles l
  ON l.player_addr = r.player
ORDER BY r.place ASC;
