-- Word Circles - Global Leaderboard with Streaks
-- All-time per-player stats: games, wins, losses, win rate, current streak,
-- max streak, average guesses on wins, average minutes-from-UTC-midnight of
-- completion.
--
-- Streak definition: a "streak" is a maximal run of consecutive gameIds the
-- player WON. Any miss (gap in gameId) or any loss breaks the streak. The
-- trick is `gameId - ROW_NUMBER() OVER (...)` — that value is constant within
-- a consecutive run and changes at every break, so it cleanly groups runs.
--
-- current_streak = streak that includes the player's most recently played
-- gameId (0 if their last game was a loss).
-- max_streak = longest streak ever.
--
-- Player names are read from an uploaded CSV table
-- (dune.bh2smith.dataset_word_circles_player_names) mapping address (varbinary)
-- -> Circles profile name. Dune's CSV upload infers the 0x-hex `player` column
-- as varbinary, so it joins directly against the on-chain `player`. Previously
-- these were resolved live via http_post to rpc.aboutcircles.com (one request
-- per player), which tripped Dune's per-execution HTTP request cap. To refresh
-- names, re-run the offline resolver (../scripts/build_circles_names.py) and
-- re-upload the CSV.

WITH all_games AS (
  SELECT player, gameId, guesses, won, evt_block_time
  FROM word_circles_gnosis.wordcirclestats_evt_gamerecorded
),
wins AS (
  SELECT player, gameId FROM all_games WHERE won
),
win_runs AS (
  SELECT
    player,
    gameId,
    gameId - CAST(ROW_NUMBER() OVER (PARTITION BY player ORDER BY gameId) AS bigint) AS grp
  FROM wins
),
streaks AS (
  SELECT
    player,
    grp,
    COUNT(*)                              AS streak_len,
    MAX(gameId)                           AS streak_last_game_id
  FROM win_runs
  GROUP BY player, grp
),
last_played AS (
  SELECT player, MAX(gameId) AS last_played_game_id
  FROM all_games
  GROUP BY player
),
streak_stats AS (
  SELECT
    s.player,
    MAX(s.streak_len) AS max_streak,
    COALESCE(
      MAX(CASE WHEN s.streak_last_game_id = lp.last_played_game_id THEN s.streak_len END),
      0
    ) AS current_streak
  FROM streaks s
  JOIN last_played lp ON lp.player = s.player
  GROUP BY s.player
),
player_aggs AS (
  SELECT
    player,
    COUNT(*)                                                                                   AS games_played,
    COUNT(*) FILTER (WHERE won)                                                                AS wins,
    COUNT(*) FILTER (WHERE NOT won)                                                            AS losses,
    ROUND(100.0 * COUNT(*) FILTER (WHERE won) / NULLIF(COUNT(*), 0), 1)                        AS win_rate_pct,
    ROUND(AVG(CASE WHEN won THEN guesses END), 2)                                              AS avg_guesses_on_wins,
    ROUND(AVG(date_diff('second', date_trunc('day', evt_block_time), evt_block_time)) / 60.0, 1) AS avg_minutes_from_utc_midnight,
    MAX(evt_block_time)                                                                        AS last_played_at
  FROM all_games
  GROUP BY player
),
player_profiles AS (
  -- Uploaded CSV table: columns (player varbinary address, name varchar)
  SELECT
    player AS player_addr,
    name   AS circles_name
  FROM dune.bh2smith.dataset_word_circles_player_names
)
SELECT
  COALESCE(
    NULLIF(pp.circles_name, ''),
    '0x' || substr(to_hex(pa.player), 1, 4) || '…' || substr(to_hex(pa.player), -4)
  )                                AS player_name,
  pa.player,
  pa.games_played,
  pa.wins,
  pa.losses,
  pa.win_rate_pct,
  COALESCE(ss.current_streak, 0) AS current_streak,
  COALESCE(ss.max_streak, 0)     AS max_streak,
  pa.avg_guesses_on_wins,
  pa.avg_minutes_from_utc_midnight,
  pa.last_played_at
FROM player_aggs pa
LEFT JOIN streak_stats ss ON ss.player = pa.player
LEFT JOIN player_profiles pp ON pp.player_addr = pa.player
ORDER BY
  COALESCE(ss.max_streak, 0) DESC,
  pa.wins DESC,
  pa.avg_guesses_on_wins ASC NULLS LAST,
  pa.avg_minutes_from_utc_midnight ASC NULLS LAST
