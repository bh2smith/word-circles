# Dune queries

SQL behind the two Word Circles Gnosis dashboards, which cross-link each other:

- [Word Circles — Daily](https://dune.com/bh2smith/word-circles-gnosis-stats) — daily-wordle leaderboards, trends, retention (`01`/`03`/`08` + headline/trend queries).
- [Word Circles — PvP](https://dune.com/bh2smith/word-circles-pvp-gnosis) — staked-match economics: player record, totals, matches, group volume (`04`–`12`).

Each `.sql` file mirrors a saved Dune query; the live query is the execution
engine, these files are the version-controlled source of truth.

Every query file starts with a `-- Dune: https://dune.com/queries/<id>` line —
that's the link back to the live query. To re-sync after editing a file, paste
its contents into that query (or push via the API) and re-run.

## Mirrored queries

| File                                | Dune ID                                     | Shows                                             |
| ----------------------------------- | ------------------------------------------- | ------------------------------------------------- |
| `01_daily_leaderboard.sql`          | [7608035](https://dune.com/queries/7608035) | Current-puzzle leaderboard                        |
| `03_global_leaderboard_streaks.sql` | [7608038](https://dune.com/queries/7608038) | All-time leaderboard with streaks                 |
| `04_pvp_game_lifecycle.sql`         | [7647933](https://dune.com/queries/7647933) | One row per PvP game (stake/pot/payout/settle)    |
| `05_pvp_player_leaderboard.sql`     | [7647942](https://dune.com/queries/7647942) | Per-player record: played/won/lost/draw + profit  |
| `06_pvp_daily_activity.sql`         | [7647948](https://dune.com/queries/7647948) | Daily PvP funnel & CRC volume                     |
| `07_pvp_group_tokens.sql`           | [7662925](https://dune.com/queries/7662925) | Volume & games per group token                    |
| `08_daily_retention.sql`            | [7662928](https://dune.com/queries/7662928) | New vs returning players, next-day retention      |
| `09_pvp_matches.sql`                | [7662938](https://dune.com/queries/7662938) | Match feed (participants & winners)               |
| `10_pvp_group_volume_daily.sql`     | [7662942](https://dune.com/queries/7662942) | Daily PvP stake/payout split by group             |
| `11_pvp_revenue.sql`                | [7665765](https://dune.com/queries/7665765) | Daily + cumulative PvP rake (0 until a fee added) |
| `12_pvp_totals.sql`                 | [7665840](https://dune.com/queries/7665840) | Headline PvP totals (games, players, volume)      |

Name resolution is documented per file (uploaded Circles-name CSV →
`dune/uploads/`, with a live `rpc.aboutcircles.com` fallback for unresolved
addresses; group tokens map wrapper → avatar → name).

## On the dashboard but not mirrored here

These power the headline counters / trend charts and aren't checked in (no
custom logic worth versioning):

| Dune ID                                     | Shows                                 |
| ------------------------------------------- | ------------------------------------- |
| [7608034](https://dune.com/queries/7608034) | Headline counters (total games, etc.) |
| [7608039](https://dune.com/queries/7608039) | Daily activity (wins + losses)        |
| [7608040](https://dune.com/queries/7608040) | Guesses distribution                  |
| [7608041](https://dune.com/queries/7608041) | Submissions by hour (UTC)             |
