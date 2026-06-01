# Dune uploaded tables

Generated CSVs uploaded to Dune and read by the queries in `../queries`. The
CSVs themselves are **not committed** (gitignored) — they are build artifacts,
and the uploaded Dune table is the source of truth. Rebuild and re-upload when
you want to refresh.

## `circles_profile_names.csv` → `dune.<handle>.dataset_word_circles_player_names`

Maps a Circles avatar's lowercase `0x` address to its display `name` (~9.5k
named avatars): humans' off-chain profile names plus on-chain group/org names.
The `player` column is `0x` hex, which Dune's CSV import infers as `varbinary`,
so it joins directly against the on-chain `player` address.

Read by the leaderboard queries
[`../queries/03_global_leaderboard_streaks.sql`](../queries/03_global_leaderboard_streaks.sql)
([7608038](https://dune.com/queries/7608038)) and
[`../queries/01_daily_leaderboard.sql`](../queries/01_daily_leaderboard.sql)
([7608035](https://dune.com/queries/7608035)). It replaced a per-player
`http_post` to `rpc.aboutcircles.com`, which tripped Dune's per-execution HTTP
request cap ("too many HTTP requests").

### Rebuild

```sh
python3 dune/scripts/build_circles_names.py   # rewrites circles_profile_names.csv
```

It lists all avatars via `circles_query` (`V_CrcV2.Avatars`) and resolves human
display names from their profile CIDs via `profiles/getBatch` (50 CIDs/request,
retried over several passes since IPFS fetches transiently fail — coverage is a
good majority, not 100%).

### Upload

Via the API (overwrites on matching `table_name`):

```sh
curl -X POST https://api.dune.com/api/v1/uploads/csv \
  -H "X-DUNE-API-KEY: $DUNE_API_KEY" -H 'Content-Type: application/json' \
  -d "$(python3 -c 'import json,sys;print(json.dumps({"data":open(sys.argv[1]).read(),"table_name":"word_circles_player_names","is_private":False}))' dune/uploads/circles_profile_names.csv)"
```

Or in the UI: **Upload Data** → pick the CSV → name the dataset **exactly**
`word_circles_player_names`. If you upload under a different handle/team, adjust
the `dune.bh2smith.…` table reference in the two queries.
