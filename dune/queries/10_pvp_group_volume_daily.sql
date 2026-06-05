-- Dune: https://dune.com/queries/7662942
-- Word Circles PvP — Group Volume Over Time
-- Daily PvP stake & payout volume (CRC) split by the group token staked, to
-- show multi-group adoption since players could pick different group tokens.
-- One row per (day, group); chart with group_name as the series (group_by).
WITH created AS (
  SELECT gameId, token, CAST(amount AS double) AS stake_wei
  FROM word_circles_gnosis.wordcirclesescrow_evt_created
),
joined AS (
  SELECT gameId, player, evt_block_time AS joined_at
  FROM word_circles_gnosis.wordcirclesescrow_evt_joined
),
resolved AS (
  SELECT gameId, evt_block_time AS resolved_at,
         (SELECT SUM(x) FROM UNNEST(amounts) AS u(x)) AS payout_wei
  FROM word_circles_gnosis.wordcirclesescrow_evt_resolved
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
  SELECT DISTINCT tg.avatar AS addr FROM tok_group tg
  LEFT JOIN group_csv g ON g.addr = tg.avatar
  WHERE tg.avatar IS NOT NULL AND NULLIF(g.name, '') IS NULL
),
live_groups AS (
  SELECT addr,
    json_value(http_post('https://rpc.aboutcircles.com/',
      '{"jsonrpc":"2.0","id":1,"method":"circles_getProfileByAddress","params":["0x' || to_hex(addr) || '"]}',
      ARRAY['Content-Type: application/json']), 'lax $.result.name') AS name
  FROM unresolved_groups
),
gname AS (
  SELECT tg.token,
    COALESCE(NULLIF(g.name, ''), NULLIF(lg.name, ''),
      '0x' || substr(to_hex(tg.token), 1, 4) || '…' || substr(to_hex(tg.token), -4)) AS group_name
  FROM tok_group tg
  LEFT JOIN group_csv   g  ON g.addr  = tg.avatar
  LEFT JOIN live_groups lg ON lg.addr = tg.avatar
),
d_stake AS (
  SELECT date_trunc('day', j.joined_at) AS day, c.token,
         COUNT(*) AS entries, SUM(c.stake_wei) / 1e18 AS stake_crc
  FROM joined j JOIN created c ON c.gameId = j.gameId
  GROUP BY 1, 2
),
d_payout AS (
  SELECT date_trunc('day', r.resolved_at) AS day, c.token,
         SUM(r.payout_wei) / 1e18 AS payout_crc
  FROM resolved r JOIN created c ON c.gameId = r.gameId
  GROUP BY 1, 2
)
SELECT
  COALESCE(ds.day, dp.day)              AS day,
  gn.group_name,
  COALESCE(ds.entries, 0)              AS entries,
  ROUND(COALESCE(ds.stake_crc, 0), 3)  AS stake_volume_crc,
  ROUND(COALESCE(dp.payout_crc, 0), 3) AS payout_volume_crc
FROM d_stake ds
FULL OUTER JOIN d_payout dp ON dp.day = ds.day AND dp.token = ds.token
LEFT JOIN gname gn ON gn.token = COALESCE(ds.token, dp.token)
ORDER BY day DESC, stake_volume_crc DESC
