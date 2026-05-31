# Dune uploaded tables

CSV datasets uploaded to Dune and read by queries in `../queries`.

## `player_names.csv` → `dune.<handle>.dataset_word_circles_player_names`

Maps a player's lowercase `0x` address to their Circles profile `name`.

Read by [`../queries/03_global_leaderboard_streaks.sql`](../queries/03_global_leaderboard_streaks.sql)
(Dune query [7608038](https://dune.com/queries/7608038)). It replaced a
per-player `http_post` to `rpc.aboutcircles.com`, which tripped Dune's
per-execution HTTP request cap ("too many HTTP requests").

### Refresh

```sh
# resolve names offline and rewrite player_names.csv
DUNE_API_KEY=… ./dune/scripts/refresh_player_names.sh
# or feed addresses directly (no API key needed):
#   ./dune/scripts/refresh_player_names.sh 0xabc… 0xdef…
```

Then re-upload in Dune: **Upload Data** → pick `player_names.csv` → name the
dataset **exactly** `word_circles_player_names` (re-uploading with the same name
overwrites). The query assumes handle `bh2smith`; adjust the table reference in
the SQL if you upload under a different handle/team.
