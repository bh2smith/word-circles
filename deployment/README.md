# Backend Deployment (DAppNode)

The backend runs as a DAppNode package with three services:

- **postgres** — Postgres 16 shared between the api and the indexer
- **api** — Rust/Axum backend (pre-built Docker image)
- **indexer** — [arak](https://github.com/bh2smith/arak) sidecar (own fork), polls Gnosis chain events and writes them straight into Postgres (no SQLite sidecar)

## Prerequisites

- DAppNode with a Gnosis execution client (e.g. Erigon, Nethermind)
- The resolver wallet funded with xDAI for gas on Gnosis chain

## Install

Install via the DAppNode SDK or build locally:

```bash
cd deployment
npx @dappnode/dappnodesdk build
```

This produces an `.xz` package you can sideload through the DAppNode admin UI.

## Configuration

The DAppNode setup wizard prompts for these on install. They can also be changed later in the package config UI.

| Variable               | Required | Default                                      | Description                                                                                                                |
| ---------------------- | -------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `RESOLVER_PRIVATE_KEY` | Yes      | —                                            | Hex-encoded private key for the resolver wallet. Signs commitments and settlements on-chain.                               |
| `RPC_URL`              | No       | `http://gnosis-erigon.dappnode:8545`         | Gnosis RPC endpoint. Defaults to local Erigon.                                                                             |
| `COMMITMENT_ADDRESS`   | No       | `0x6e99c40bd8b87290EB977336c4Be8b2106baB08f` | Deployed WordCommitment contract address.                                                                                  |
| `STATS_ADDRESS`        | No       | `0xB96413584d7a4e07cc8c238cC4baA3474C956CCF` | Deployed WordCircleStats contract address.                                                                                 |
| `PVP_ENABLED`          | No       | `false`                                      | Master switch for PvP matchmaking and escrow game preparation.                                                             |
| `PVP_LOBBIES`          | No       | —                                            | JSON array of per-group lobbies (see [docs/multi-group-pvp.md](../docs/multi-group-pvp.md)). Required when PvP is enabled. |
| `GROUP_ADDRESS`        | No       | —                                            | Circles group players are trusted into via `POST /api/group/join`. Resolver must be its owner/service.                     |

## Funding the Resolver

The resolver address needs xDAI to submit transactions. Check the balance:

```bash
cast balance 0x8ba11AdD9bB5B60028eff90A14f0AE20b429ce8F --rpc-url https://rpc.gnosis.gateway.fm
```

Send xDAI from any wallet to fund it. A few cents covers thousands of commitment transactions.

## Verifying the Deployment

### Health check

```bash
curl http://<dappnode-ip>:3001/health
# Returns: ok
```

### Config endpoint

```bash
curl http://<dappnode-ip>:3001/api/config
```

Returns resolver address, contract addresses, and `pvpEnabled` status. If the resolver isn't configured, this returns `503`.

### Logs

Check logs in the DAppNode Packages UI, or via SSH:

```bash
docker logs DAppNodePackage-word-circles.public.dappnode.eth-api
docker logs DAppNodePackage-word-circles.public.dappnode.eth-indexer
```

Look for:

- `Resolver wallet loaded` — confirms the private key is valid
- `Event listener enabled (polling arak)` — confirms the api's polling loop started
- `Backend listening on 0.0.0.0:3001` — confirms the API is up
- On the **indexer** container: arak's own startup banner + per-event sync messages

## Updating

1. Bump the version in `dappnode_package.json`
2. Update the image tag in `api/Dockerfile`
3. Rebuild: `npx @dappnode/dappnodesdk build`
4. Install the new package through the DAppNode admin UI

Game state lives in the `pgdata` volume (Postgres). There's no longer a shared SQLite volume — the indexer writes to the same Postgres as the api.

## Backup & rollback

### What's irreplaceable

All off-chain state — games, guesses, and PvP history — lives **only** in the
`pgdata` Postgres volume, shared by the `api` and `indexer` (arak) services.
arak's event tables (`created`/`joined`/`resolved`/`game_recorded`) are
re-derivable from chain by re-syncing, so the **app's `games`/`players`/guess
rows are the only data that cannot be reconstructed**.

> ⚠️ **Uninstalling the DAppNode package deletes the `pgdata` volume** — and with
> it every game and guess. Always `pg_dump` first (below). An in-place version
> rollback (next section) keeps the volume; an uninstall/reinstall does not.

### Take a backup (`pg_dump`)

Run against the postgres container (Postgres 16; role/db both `wordcircles`).
Use the custom format (`-Fc`) so it can be restored selectively:

```bash
docker exec DAppNodePackage-word-circles.public.dappnode.eth-postgres \
  pg_dump -U wordcircles -d wordcircles -Fc \
  > word-circles-$(date +%Y%m%d-%H%M%S).dump
```

Copy the resulting `.dump` off the DAppNode host (e.g. `scp`) so it survives a
package uninstall.

### Restore (`pg_restore`)

Into a running postgres container (e.g. after a fresh reinstall):

```bash
docker cp word-circles-<timestamp>.dump \
  DAppNodePackage-word-circles.public.dappnode.eth-postgres:/tmp/restore.dump

docker exec DAppNodePackage-word-circles.public.dappnode.eth-postgres \
  pg_restore -U wordcircles -d wordcircles --clean --if-exists /tmp/restore.dump
```

arak's event tables will re-sync from chain on the next indexer start, so a
restore primarily needs to bring back the app game/guess data.

### Rolling back a release

**Preferred: in-place DAppNode version rollback.** From the package's UI, roll
back to the previous version. This keeps the `pgdata` volume, so no data is
lost and no restore is needed.

- **Safe with no schema change.** The api runs migrations forward on startup;
  rolling the image back to a version that predates a migration can leave the
  schema ahead of the code. If the rollback crosses a migration boundary,
  restore a `pg_dump` taken **before** that migration into a clean volume
  instead of relying on the in-place rollback.
- When in doubt, take a `pg_dump` before rolling back regardless — it's cheap
  insurance against an unexpected schema mismatch.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│ DAppNode                                                │
│                                                         │
│  ┌──────────────┐    ┌──────────────┐                   │
│  │   indexer    │    │     api      │                   │
│  │    (arak)    │    │ (axum:3001)  │                   │
│  │              │    │              │                   │
│  │ polls Gnosis │    │ serves game  │                   │
│  │ RPC, writes  │    │ reads same   │                   │
│  │ event tables │    │ Postgres for │                   │
│  │ into shared  │    │ new events,  │                   │
│  │ Postgres     │    │ writes app   │                   │
│  │              │    │ state        │                   │
│  └──────┬───────┘    └──────┬───────┘                   │
│         │                   │                           │
│         └────────┬──────────┘                           │
│                  ▼                                      │
│           ┌──────────────┐                              │
│           │   postgres   │                              │
│           │ created/     │  ← arak's event tables       │
│           │ joined/      │    (public schema)           │
│           │ resolved/    │                              │
│           │ game_recorded│                              │
│           │ public.games │  ← app state                 │
│           │ /players/... │                              │
│           └──────────────┘                              │
│                  │                                      │
│                  ▼                                      │
│              /var/lib/postgresql/data (pgdata volume)   │
└─────────────────────────────────────────────────────────┘
         │                          │
         ▼                          ▼
   Gnosis Chain                Frontend
   (events, txs)               (Vercel)
```
