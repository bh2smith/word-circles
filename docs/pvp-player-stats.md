# In-app PvP player stats — played / won / lost / profit

Implementation plan for showing an individual player their PvP record inside the
app: **games played, won, lost, drawn, and net profit (+/- CRC)**. Mirrors the
Dune query [`dune/queries/05_pvp_player_leaderboard.sql`](../dune/queries/05_pvp_player_leaderboard.sql)
(Dune 7647942) but served from the backend so a player sees their own numbers
live in the product.

## Status — planned (2026-06-06)

Scoped, not yet implemented. Data-source decision made: **persist the outcome at
settlement time** (a `pvp_results` table), rather than reading RPC or re-deriving
on every request.

## Goal

A "Your PvP record" card on the PvP history page showing, for the connected
wallet:

| Played | Won | Lost | Drew | Staked | Won  | **Profit** |
| ------ | --- | ---- | ---- | ------ | ---- | ---------- |
| 42     | 23  | 17   | 2    | 24.9   | 28.2 | **+3.3**   |

Stat definitions (identical to Dune q05, computed over **settled** games only):

- **win** — player is the sole entry in `Resolved.winners[]`.
- **draw** — player is one of 2 winners (split pot; lobbies are 2-player).
- **loss** — player took part but is not in `winners[]`.
- **profit** = CRC won − CRC staked. Already nets the stake, so it stays correct
  once a protocol rake is enabled (the rake only shrinks future payouts; see
  [`dune/queries/11_pvp_revenue.sql`](../dune/queries/11_pvp_revenue.sql)).

## Data source — persist at settlement (decided)

**Why not the alternatives:**

- The backend DB does **not** currently store outcomes. `game_players`
  (`backend/migrations/001_init.sql:45`) has `solved` / `guess_count` /
  `finished_at` but no winner or payout. Settlement is on-chain only.
- Reading escrow RPC per request → slow, rate-limit risk.
- The arak `resolved` event table is local (the indexer already polls it,
  `backend/src/indexer.rs:19`), but it only exposes `gameid_0` today
  (`backend/src/indexer.rs:260`); reading `winners[]`/`amounts[]` would require
  confirming how arak encodes dynamic Solidity arrays in Postgres columns.

**Chosen approach:** the backend already computes the winners and payouts at
settlement. `settle_game` (`backend/src/settlement.rs:165`) calls
`determine_winner` (line 78) → `result.winners` / `result.amounts`, signs, and
submits the resolve tx (line 229). Right after the resolve tx is accepted, write
one row **per participant** to a new `pvp_results` table. Stats become a trivial
`GROUP BY`. No RPC, no arak array decoding, exact parity with what we settled.

## Backend changes (`backend/`)

### 1. Migration — `migrations/003_pvp_results.sql`

One denormalized row per (game, participant) so stats are a pure aggregate:

```sql
CREATE TABLE pvp_results (
    game_id     TEXT NOT NULL,
    player      TEXT NOT NULL,              -- 0x-prefixed, lowercased
    outcome     TEXT NOT NULL,              -- 'win' | 'loss' | 'draw'
    staked_wei  NUMERIC NOT NULL,           -- game.amount (per-player stake)
    payout_wei  NUMERIC NOT NULL DEFAULT 0, -- CRC received (0 for losers)
    settled_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (game_id, player)
);
CREATE INDEX idx_pvp_results_player ON pvp_results(player);
```

(`amount`/wei kept as `NUMERIC`/string to match the existing `games.amount`
convention.)

### 2. Write at settlement — `src/settlement.rs`

In `settle_game`, after the resolve tx is submitted (after line 230), insert one
row per participant: outcome from membership in `result.winners`
(`len == 1` → win, `len == 2` → draw, else loss), `staked_wei = game.amount`,
`payout_wei` = the player's entry in `result.amounts` (0 if not a winner). Make
the insert idempotent (`ON CONFLICT (game_id, player) DO NOTHING`) so a retried
settlement doesn't double-count. Insert is best-effort/logged — it must not block
the resolve/reveal flow.

### 3. Model + repository — `src/db/`

- `src/db/models.rs` — add `PvpPlayerStats { games_played, games_won, games_lost,
games_drawn, staked_crc, won_crc, net_crc }` (CRC as decimal strings, like
  `amount`).
- `src/db/repository.rs` — extend the `GameRepository` trait
  (`backend/src/db/repository.rs:26`) with
  `async fn record_pvp_result(...)` and
  `async fn get_pvp_player_stats(&self, player: &str) -> Result<PvpPlayerStats>`.
- `src/db/postgres.rs` — implement both. Stats query:
  ```sql
  SELECT
    count(*)                                  AS games_played,
    count(*) FILTER (WHERE outcome='win')     AS games_won,
    count(*) FILTER (WHERE outcome='loss')    AS games_lost,
    count(*) FILTER (WHERE outcome='draw')    AS games_drawn,
    sum(staked_wei)                           AS staked_wei,
    sum(payout_wei)                           AS won_wei,
    sum(payout_wei) - sum(staked_wei)         AS net_wei
  FROM pvp_results WHERE player = lower($1);
  ```
  (Scale wei → CRC in Rust, /1e18, same as elsewhere.)
- Mirror in the in-memory test repo so unit tests compile.

### 4. Endpoint + OpenAPI — `src/lib.rs`

- New `#[derive(Serialize, ToSchema)] PvpPlayerStats`.
- Handler `GET /api/player/{player}/stats` (validate the address, call
  `repo.get_pvp_player_stats`), modeled on `get_leaderboard`. Register the path +
  schema in `ApiDoc` and add the route.
- Run `bun run gen:api` → `src/lib/api/types.ts` regenerates; the openapi-drift CI
  gate then passes.

### 5. Backfill the ~49 existing settled games

One-off (a `--backfill` subcommand or a guarded startup task): for each game with
`status = 'settled'`, recompute the outcome with the **existing**
`determine_winner` over its `game_players` + tiles (all already in the DB) and
insert `pvp_results` rows. Reuses settled logic — no chain reads, no arak array
decode. Optional: cross-check the recomputed winners against the arak `resolved`
table as a validation pass.

> Risk: if `determine_winner` logic changed since a game settled, a recompute
> could differ from what actually paid out on-chain. Low (logic is deterministic
> and stable); the optional arak cross-check catches any drift.

## Frontend changes (`src/`)

- New `src/components/PvpStatsCard.tsx` — model on `src/components/StatsModal.tsx`
  (4-up grid, dark theme). Fetch via the typed client:
  `api.GET("/api/player/{player}/stats", { params: { path: { player } } })`.
  Loading skeleton + graceful error like `src/components/Leaderboard.tsx`.
- Current address from `getConnectedAddress()` (`src/lib/circles.ts`), already
  used by `src/components/PvpHistory.tsx`.
- Mount it at the top of `src/components/PvpHistory.tsx` (the PvP history view),
  above the game list.

## Test plan

- **Backend unit:** `determine_winner` → `pvp_results` row mapping for win / loss
  / draw; `get_pvp_player_stats` aggregation on a seeded in-memory repo
  (incl. a player with a draw, and the zero-games case).
- **Backfill:** assert recomputed counts for a known fixture match the Dune q05
  numbers (e.g. bh2smith 23/17/2, +3.3 CRC) — a regression anchor.
- **Frontend:** component renders the four headline numbers; profit colored
  ±; empty state for a wallet with no PvP games.

## CI gates (run before PR — `/ci-lint`)

`cargo fmt`/`clippy`/`test` (backend), `forge` (unchanged here), `bun` lint/build,
and the **openapi drift** check (regenerate `types.ts` after the new endpoint).

## Open questions

1. **Endpoint privacy** — return stats for any `{player}` (enables future
   profile/leaderboard reuse) vs. gate to the connected wallet. Default proposed:
   public by address, matching `/api/leaderboard`.
2. **In-flight games** — unsettled games are excluded from the record (parity with
   Dune q05; an escrowed stake is neither won nor lost). Could show a separate
   "in progress" count from `game_players` if wanted.
3. **Surface** — history page card only, or also a compact badge on the PvP play
   screen?
