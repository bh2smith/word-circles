# Dune uploaded tables

CSV datasets uploaded to Dune and read by the queries in `../queries`.

Both CSVs below target the **same** Dune table,
`dune.<handle>.dataset_word_circles_player_names` (handle `bh2smith`). Whichever
you upload last wins — re-uploading with the same dataset name overwrites. The
`player` column is lowercase `0x` hex, which Dune's CSV import infers as
`varbinary`, so it joins directly against the on-chain `player` address.

The table replaced a per-player `http_post` to `rpc.aboutcircles.com` in the
leaderboard queries ([7608038](https://dune.com/queries/7608038),
[7608035](https://dune.com/queries/7608035)), which tripped Dune's
per-execution HTTP request cap ("too many HTTP requests").

## `circles_profile_names.csv` — comprehensive (current upload)

Every Circles avatar that has a name (~9.5k rows): humans' off-chain profile
names plus on-chain group/organization names. This is the dataset currently
backing the table, so any future player is resolved without a re-scrape.

Built by [`../scripts/build_circles_names.py`](../scripts/build_circles_names.py):

```sh
python3 dune/scripts/build_circles_names.py   # rewrites circles_profile_names.csv
```

It lists all avatars via `circles_query` (V_CrcV2.Avatars) and resolves human
display names from their profile CIDs via `profiles/getBatch` (50 CIDs/request,
retried over several passes since IPFS fetches transiently fail — coverage is a
good majority, not 100%).

## `player_names.csv` — Word Circles players only (seed)

The 22 addresses that have played Word Circles, mapped to their Circles name.
Smaller, exact seed used by
[`../scripts/refresh_player_names.sh`](../scripts/refresh_player_names.sh) and
merged into the comprehensive set to guarantee every actual player is covered.

```sh
# resolve names offline and rewrite player_names.csv
DUNE_API_KEY=… ./dune/scripts/refresh_player_names.sh
# or feed addresses directly (no API key needed):
#   ./dune/scripts/refresh_player_names.sh 0xabc… 0xdef…
```

## Uploading

Via the API (overwrites on matching `table_name`):

```sh
curl -X POST https://api.dune.com/api/v1/uploads/csv \
  -H "X-DUNE-API-KEY: $DUNE_API_KEY" -H 'Content-Type: application/json' \
  -d "$(python3 -c 'import json,sys;print(json.dumps({"data":open(sys.argv[1]).read(),"table_name":"word_circles_player_names","is_private":False}))' dune/uploads/circles_profile_names.csv)"
```

Or in the UI: **Upload Data** → pick the CSV → name the dataset **exactly**
`word_circles_player_names`. If you upload under a different handle/team, adjust
the `dune.bh2smith.…` table reference in the two queries.
