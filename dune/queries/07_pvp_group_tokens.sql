-- Dune: https://dune.com/queries/7662925
-- Word Circles PvP — Volume & Games per Group Token
-- Players can stake different Circles group tokens in PvP. This breaks the
-- on-chain escrow activity down by that stake token.
--
-- Group naming: the escrow `token` is the ERC20 *wrapper* of a group's CRC, not
-- the group's avatar. circles_ubi_v2_gnosis.erc20lift_evt_erc20wrapperdeployed
-- maps wrapper -> avatar; the avatar is then named from the uploaded Circles
-- name CSV with a live rpc.aboutcircles.com fallback for any group the CSV
-- missed (same hybrid pattern as the leaderboards). Falls back to a short 0x.
WITH created AS (
  SELECT gameId, token, CAST(amount AS double) AS stake_wei,
         CAST(capacity AS double) AS capacity, evt_block_time AS created_at
  FROM word_circles_gnosis.wordcirclesescrow_evt_created
),
resolved AS (
  SELECT gameId, (SELECT SUM(x) FROM UNNEST(amounts) AS u(x)) AS payout_wei
  FROM word_circles_gnosis.wordcirclesescrow_evt_resolved
),
joined AS (
  SELECT gameId, player FROM word_circles_gnosis.wordcirclesescrow_evt_joined
),
wrap AS (
  SELECT erc20Wrapper AS token, MAX(avatar) AS avatar
  FROM circles_ubi_v2_gnosis.erc20lift_evt_erc20wrapperdeployed
  GROUP BY erc20Wrapper
),
group_csv AS (
  SELECT player AS addr, name FROM dune.bh2smith.dataset_word_circles_player_names
),
tok_group AS (
  SELECT DISTINCT c.token, w.avatar
  FROM created c LEFT JOIN wrap w ON w.token = c.token
),
unresolved_groups AS (
  SELECT DISTINCT tg.avatar AS addr
  FROM tok_group tg LEFT JOIN group_csv g ON g.addr = tg.avatar
  WHERE tg.avatar IS NOT NULL AND NULLIF(g.name, '') IS NULL
),
live_groups AS (
  SELECT addr,
    json_value(
      http_post(
        'https://rpc.aboutcircles.com/',
        '{"jsonrpc":"2.0","id":1,"method":"circles_getProfileByAddress","params":["0x' || to_hex(addr) || '"]}',
        ARRAY['Content-Type: application/json']
      ),
      'lax $.result.name'
    ) AS name
  FROM unresolved_groups
),
g_created AS (
  SELECT token, COUNT(*) AS games_created,
         SUM(stake_wei * capacity) / 1e18 AS pot_opened_crc
  FROM created GROUP BY token
),
g_resolved AS (
  SELECT c.token, COUNT(*) AS games_resolved, SUM(r.payout_wei) / 1e18 AS payout_crc
  FROM resolved r JOIN created c ON c.gameId = r.gameId
  GROUP BY c.token
),
g_entries AS (
  SELECT c.token,
         COUNT(*) AS total_entries,
         COUNT(DISTINCT j.player) AS distinct_players,
         SUM(c.stake_wei) FILTER (WHERE r.gameId IS NOT NULL) / 1e18 AS stake_settled_crc
  FROM joined j
  JOIN created c ON c.gameId = j.gameId
  LEFT JOIN resolved r ON r.gameId = j.gameId
  GROUP BY c.token
)
SELECT
  COALESCE(
    NULLIF(g.name, ''),
    NULLIF(lg.name, ''),
    '0x' || substr(to_hex(gc.token), 1, 4) || '…' || substr(to_hex(gc.token), -4)
  ) AS group_name,
  gc.token,
  gc.games_created,
  COALESCE(gr.games_resolved, 0) AS games_resolved,
  COALESCE(ge.distinct_players, 0) AS distinct_players,
  COALESCE(ge.total_entries, 0) AS total_entries,
  ROUND(COALESCE(ge.stake_settled_crc, 0), 3) AS stake_settled_crc,
  ROUND(COALESCE(gr.payout_crc, 0), 3) AS payout_crc,
  ROUND(gc.pot_opened_crc, 3) AS pot_opened_crc
FROM g_created gc
LEFT JOIN g_resolved gr ON gr.token = gc.token
LEFT JOIN g_entries  ge ON ge.token = gc.token
LEFT JOIN tok_group  tg ON tg.token = gc.token
LEFT JOIN group_csv  g  ON g.addr   = tg.avatar
LEFT JOIN live_groups lg ON lg.addr = tg.avatar
ORDER BY gc.games_created DESC
