-- Dune: https://dune.com/queries/7647933
-- Word Circles PvP - Game Lifecycle (one row per on-chain game)
-- Stitches the full lifecycle of every staked PvP game from the two on-chain
-- contracts: WordCirclesEscrow (stake/lobby/payout) and WordCommitment (the
-- hidden word's commit/reveal). One row per escrow `gameId`, with timings,
-- amounts and settlement status.
--
-- ┌─ WordCirclesEscrow ────────────────────────────────────────────────┐
-- │  Created(gameId, player, resolver, token, amount, capacity)         │  lobby opens (first join)
-- │  Joined (gameId, creator, player, players)                          │  one per participant
-- │  Resolved(gameId, address[] winners, uint256[] amounts)             │  pot paid out
-- └─────────────────────────────────────────────────────────────────────┘
-- ┌─ WordCommitment ──────────────────────────────────────────────────┐
-- │  Committed(gameId, commitmentHash)                                  │  word locked in
-- │  Revealed (gameId, wordIndex, salt)                                 │  word disclosed at settle
-- └─────────────────────────────────────────────────────────────────────┘
--
-- The escrow + commitment contracts are decoded on Dune under the
-- `word_circles_gnosis` namespace (Gnosis / chain 100), same as the existing
-- `wordcirclestats_*` tables:
--   WordCirclesEscrow  0x20a44c2c546febb4dce773868b532d14663467a0
--   WordCommitment     0x6e99c40bd8b87290eb977336c4be8b2106bab08f
-- Decoded table names follow Dune's `<namespace>_<chain>.<contract>_evt_<Event>`
-- convention, e.g. word_circles_gnosis.wordcirclesescrow_evt_created.
--
-- Per-guess play (boards, guess counts, who solved) is stored off-chain in the
-- backend DB and is NOT on-chain, so it can't appear here — only the staking and
-- settlement skeleton is observable on Gnosis.
--
-- Circles stake tokens are 18-decimal, so wei amounts are scaled to whole CRC.
--
-- The creator's name uses the same hybrid resolution as the daily-Wordle boards
-- (see 01_daily_leaderboard.sql): the uploaded CSV
-- (dune.bh2smith.dataset_word_circles_player_names, address varbinary -> name)
-- covers the bulk, then a live http_post to rpc.aboutcircles.com names ONLY the
-- creators the CSV missed — keeping the live calls (and thus the per-execution
-- HTTP count) bounded. Falls back to the truncated 0x address.

WITH created AS (
  SELECT
    gameId,
    player              AS creator,
    resolver,
    token,
    amount              AS stake_wei,   -- per-player stake
    capacity,
    evt_block_time      AS created_at,
    evt_tx_hash         AS create_tx
  FROM word_circles_gnosis.wordcirclesescrow_evt_created
),
joins AS (
  SELECT
    gameId,
    MAX(players)        AS players_joined,   -- running counter, so the max is the final headcount
    MIN(evt_block_time) AS first_join_at,
    MAX(evt_block_time) AS last_join_at       -- for a lobby that filled, this is the fill moment
  FROM word_circles_gnosis.wordcirclesescrow_evt_joined
  GROUP BY gameId
),
resolved AS (
  SELECT
    gameId,
    evt_block_time         AS resolved_at,
    evt_tx_hash            AS resolve_tx,
    cardinality(winners)   AS winner_count,           -- 1 = outright win, 2 = split/draw
    (SELECT SUM(x) FROM UNNEST(amounts) AS u(x)) AS payout_wei
  FROM word_circles_gnosis.wordcirclesescrow_evt_resolved
),
committed AS (
  SELECT gameId, MIN(evt_block_time) AS committed_at
  FROM word_circles_gnosis.wordcommitment_evt_committed
  GROUP BY gameId
),
revealed AS (
  SELECT
    gameId,
    MIN(evt_block_time)  AS revealed_at,
    MIN(wordIndex)       AS word_index   -- index into the answer list (revealed only at settle)
  FROM word_circles_gnosis.wordcommitment_evt_revealed
  GROUP BY gameId
),
player_profiles AS (
  -- Uploaded CSV table: columns (player varbinary address, name varchar)
  SELECT player AS player_addr, name AS circles_name
  FROM dune.bh2smith.dataset_word_circles_player_names
),
-- Creators the CSV did not name; resolved live below.
unresolved_creators AS (
  SELECT DISTINCT c.creator AS player_addr
  FROM created c
  LEFT JOIN player_profiles pp ON pp.player_addr = c.creator
  WHERE NULLIF(pp.circles_name, '') IS NULL
),
-- Live fallback: one http_post per unresolved creator (kept small so we stay
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
  FROM unresolved_creators
)
SELECT
  c.gameId                                                        AS game_id,
  CASE
    WHEN r.resolved_at IS NOT NULL                THEN 'resolved'
    WHEN COALESCE(j.players_joined, 1) >= c.capacity THEN 'full · awaiting settlement'
    ELSE 'open · awaiting opponent'
  END                                                             AS status,
  COALESCE(
    NULLIF(pp.circles_name, ''),
    NULLIF(lp.circles_name, ''),
    '0x' || substr(to_hex(c.creator), 1, 4) || '…' || substr(to_hex(c.creator), -4)
  )                                                               AS creator_name,
  c.creator,
  CAST(c.capacity AS integer)                                     AS capacity,
  CAST(COALESCE(j.players_joined, 1) AS integer)                  AS players_joined,
  CAST(c.stake_wei AS double) / 1e18                              AS stake_crc,
  CAST(c.stake_wei AS double) * CAST(c.capacity AS double) / 1e18 AS pot_crc,
  CAST(r.payout_wei AS double) / 1e18                             AS payout_crc,
  -- Anything in the pot not paid to winners stays escrowed / unallocated.
  (CAST(c.stake_wei AS double) * CAST(c.capacity AS double)
     - COALESCE(CAST(r.payout_wei AS double), 0)) / 1e18          AS pot_remainder_crc,
  r.winner_count,
  c.created_at,
  cm.committed_at,
  j.last_join_at                                                  AS filled_at,
  rv.revealed_at,
  r.resolved_at,
  rv.word_index,
  -- Lobby fill latency (only meaningful once the lobby actually filled).
  CASE WHEN COALESCE(j.players_joined, 1) >= c.capacity
       THEN date_diff('second', c.created_at, j.last_join_at) END AS seconds_to_fill,
  -- Settlement latency from a full lobby to the on-chain Resolved.
  date_diff('second', j.last_join_at, r.resolved_at)             AS seconds_to_settle,
  c.token,
  c.create_tx,
  r.resolve_tx
FROM created c
LEFT JOIN joins     j  ON j.gameId  = c.gameId
LEFT JOIN resolved  r  ON r.gameId  = c.gameId
LEFT JOIN committed cm ON cm.gameId = c.gameId
LEFT JOIN revealed  rv ON rv.gameId = c.gameId
LEFT JOIN player_profiles pp ON pp.player_addr = c.creator
LEFT JOIN live_profiles   lp ON lp.player_addr = c.creator
ORDER BY c.created_at DESC
