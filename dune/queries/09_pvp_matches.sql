-- Dune: https://dune.com/queries/7662938
-- Word Circles PvP — Matches (players & winner)
-- A match feed: one row per escrow game with its participants and winner(s),
-- the group token staked, and pot/payout in CRC.
-- Player + group names resolve from the uploaded Circles name CSV with a live
-- rpc.aboutcircles.com fallback (same hybrid pattern as the leaderboards).
WITH created AS (
  SELECT gameId, token, CAST(amount AS double) AS stake_wei,
         CAST(capacity AS double) AS capacity, evt_block_time AS created_at
  FROM word_circles_gnosis.wordcirclesescrow_evt_created
),
joined AS (
  SELECT DISTINCT gameId, player FROM word_circles_gnosis.wordcirclesescrow_evt_joined
),
resolved AS (
  SELECT gameId, evt_block_time AS resolved_at, winners,
         (SELECT SUM(x) FROM UNNEST(amounts) AS u(x)) AS payout_wei
  FROM word_circles_gnosis.wordcirclesescrow_evt_resolved
),
winners_x AS (
  SELECT gameId, w AS winner
  FROM resolved CROSS JOIN UNNEST(winners) AS t(w)
),
-- ── player-name resolver (joiners + winners) ────────────────────────────────
all_players AS (
  SELECT player AS addr FROM joined
  UNION
  SELECT winner FROM winners_x
),
pcsv AS (
  SELECT player AS addr, name FROM dune.bh2smith.dataset_word_circles_player_names
),
unresolved_p AS (
  SELECT DISTINCT a.addr FROM all_players a
  LEFT JOIN pcsv p ON p.addr = a.addr
  WHERE NULLIF(p.name, '') IS NULL
),
live_p AS (
  SELECT addr,
    json_value(http_post('https://rpc.aboutcircles.com/',
      '{"jsonrpc":"2.0","id":1,"method":"circles_getProfileByAddress","params":["0x' || to_hex(addr) || '"]}',
      ARRAY['Content-Type: application/json']), 'lax $.result.name') AS name
  FROM unresolved_p
),
pname AS (
  SELECT a.addr,
    COALESCE(NULLIF(p.name, ''), NULLIF(l.name, ''),
      '0x' || substr(to_hex(a.addr), 1, 4) || '…' || substr(to_hex(a.addr), -4)) AS name
  FROM all_players a
  LEFT JOIN pcsv  p ON p.addr = a.addr
  LEFT JOIN live_p l ON l.addr = a.addr
),
-- ── group-name resolver (token -> wrapper -> avatar -> name) ────────────────
wrap AS (
  SELECT erc20Wrapper AS token, MAX(avatar) AS avatar
  FROM circles_ubi_v2_gnosis.erc20lift_evt_erc20wrapperdeployed
  GROUP BY erc20Wrapper
),
tok_group AS (
  SELECT DISTINCT c.token, w.avatar
  FROM created c LEFT JOIN wrap w ON w.token = c.token
),
unresolved_g AS (
  SELECT DISTINCT tg.avatar AS addr FROM tok_group tg
  LEFT JOIN pcsv g ON g.addr = tg.avatar
  WHERE tg.avatar IS NOT NULL AND NULLIF(g.name, '') IS NULL
),
live_g AS (
  SELECT addr,
    json_value(http_post('https://rpc.aboutcircles.com/',
      '{"jsonrpc":"2.0","id":1,"method":"circles_getProfileByAddress","params":["0x' || to_hex(addr) || '"]}',
      ARRAY['Content-Type: application/json']), 'lax $.result.name') AS name
  FROM unresolved_g
),
gname AS (
  SELECT tg.token,
    COALESCE(NULLIF(g.name, ''), NULLIF(lg.name, ''),
      '0x' || substr(to_hex(tg.token), 1, 4) || '…' || substr(to_hex(tg.token), -4)) AS group_name
  FROM tok_group tg
  LEFT JOIN pcsv   g  ON g.addr  = tg.avatar
  LEFT JOIN live_g lg ON lg.addr = tg.avatar
),
parts AS (
  SELECT j.gameId, array_join(array_agg(pn.name ORDER BY pn.name), ', ') AS players
  FROM joined j JOIN pname pn ON pn.addr = j.player
  GROUP BY j.gameId
),
wins AS (
  SELECT wx.gameId, array_join(array_agg(pn.name ORDER BY pn.name), ', ') AS winners
  FROM winners_x wx JOIN pname pn ON pn.addr = wx.winner
  GROUP BY wx.gameId
)
SELECT
  c.created_at,
  gn.group_name,
  CASE
    WHEN r.gameId IS NOT NULL THEN 'resolved'
    WHEN (SELECT COUNT(*) FROM joined j WHERE j.gameId = c.gameId) >= c.capacity
      THEN 'full · awaiting settlement'
    ELSE 'open · awaiting opponent'
  END                                                  AS status,
  CAST(c.capacity AS integer)                          AS capacity,
  pt.players,
  w.winners,
  ROUND(c.stake_wei * c.capacity / 1e18, 3)            AS pot_crc,
  ROUND(COALESCE(r.payout_wei, 0) / 1e18, 3)           AS payout_crc,
  r.resolved_at
FROM created c
LEFT JOIN resolved r  ON r.gameId = c.gameId
LEFT JOIN gname    gn ON gn.token = c.token
LEFT JOIN parts    pt ON pt.gameId = c.gameId
LEFT JOIN wins     w  ON w.gameId  = c.gameId
ORDER BY c.created_at DESC
