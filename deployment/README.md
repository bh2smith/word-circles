# Backend Deployment (DAppNode)

The backend runs as a DAppNode package with three services:

- **postgres** — Postgres 16 shared between the api and the indexer
- **api** — Rust/Axum backend (pre-built Docker image)
- **indexer** — [rindexer](https://github.com/joshstevens19/rindexer) sidecar, polls Gnosis chain events and writes them straight into Postgres (no SQLite sidecar)

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

| Variable               | Required | Default                                      | Description                                                                                  |
| ---------------------- | -------- | -------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `RESOLVER_PRIVATE_KEY` | Yes      | —                                            | Hex-encoded private key for the resolver wallet. Signs commitments and settlements on-chain. |
| `RPC_URL`              | No       | `http://gnosis-erigon.dappnode:8545`         | Gnosis RPC endpoint. Defaults to local Erigon.                                               |
| `COMMITMENT_ADDRESS`   | No       | `0x6e99c40bd8b87290EB977336c4Be8b2106baB08f` | Deployed WordCommitment contract address.                                                    |
| `STATS_ADDRESS`        | No       | `0xB96413584d7a4e07cc8c238cC4baA3474C956CCF` | Deployed WordCircleStats contract address.                                                   |
| `PVP_ENABLED`          | No       | `false`                                      | Enable PvP matchmaking and escrow game preparation.                                          |

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
- `Event listener enabled (polling rindexer)` — confirms the api's polling loop started
- `Backend listening on 0.0.0.0:3001` — confirms the API is up
- On the **indexer** container: rindexer's own startup banner + per-event sync messages

## Updating

1. Bump the version in `dappnode_package.json`
2. Update the image tag in `api/Dockerfile`
3. Rebuild: `npx @dappnode/dappnodesdk build`
4. Install the new package through the DAppNode admin UI

Game state lives in the `pgdata` volume (Postgres). There's no longer a shared SQLite volume — the indexer writes to the same Postgres as the api.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│ DAppNode                                                │
│                                                         │
│  ┌──────────────┐    ┌──────────────┐                   │
│  │   indexer    │    │     api      │                   │
│  │  (rindexer)  │    │ (axum:3001)  │                   │
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
│           │ wc_escrow.*  │  ← rindexer's event tables   │
│           │ wc_stats.*   │                              │
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
