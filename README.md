# Word Circles

A daily Wordle-style word game with on-chain commitments and PvP escrow on Gnosis chain.

## Architecture

- **Frontend** — Next.js app (Vercel)
- **Backend** — Rust/Axum API with SQLite persistence
- **Indexer** — [Arak](https://github.com/bh2smith/arak) sidecar polling Gnosis chain events
- **Contracts** — Solidity (Foundry), deployed on Gnosis

## Contracts (Gnosis Chain)

| Contract          | Address                                      | Gnosisscan                                                                       |
| ----------------- | -------------------------------------------- | -------------------------------------------------------------------------------- |
| WordCirclesEscrow | `0x20a44c2C546FEBb4dcE773868B532D14663467A0` | [View](https://gnosisscan.io/address/0x20a44c2C546FEBb4dcE773868B532D14663467A0) |
| WordCircleStats   | `0xB96413584d7a4e07cc8c238cC4baA3474C956CCF` | [View](https://gnosisscan.io/address/0xB96413584d7a4e07cc8c238cC4baA3474C956CCF) |
| WordCommitment    | `0x6e99c40bd8b87290EB977336c4Be8b2106baB08f` | [View](https://gnosisscan.io/address/0x6e99c40bd8b87290EB977336c4Be8b2106baB08f) |

**Roles:**

- Owner: `0xB00b4C1e371DEe4F6F32072641430656D3F7c064`
- Resolver: `0x8ba11AdD9bB5B60028eff90A14f0AE20b429ce8F`

## Development

```bash
# Frontend
npm install && npm run dev

# Backend
cd backend && cargo run

# Contracts
forge build && forge test
```

## Deployment

```bash
# Import wallets (one-time)
cast wallet import deployer --interactive
cast wallet import resolver --interactive

# Deploy contracts to Gnosis
make deploy
```

See `deployment/` for DAppNode packaging.
