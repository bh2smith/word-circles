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
| WordCirclesEscrow | `0x924c0d0D66007882FdDaeb0d2c6e5447de2f7C75` | [View](https://gnosisscan.io/address/0x924c0d0D66007882FdDaeb0d2c6e5447de2f7C75) |
| WordCircleStats   | `0x5f0FD6BDFb9127bc569E94A2c21699301E64477C` | [View](https://gnosisscan.io/address/0x5f0FD6BDFb9127bc569E94A2c21699301E64477C) |
| WordCommitment    | `0x072f934b7949D2a71EBb420d1147ff9de5E03170` | [View](https://gnosisscan.io/address/0x072f934b7949D2a71EBb420d1147ff9de5E03170) |

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
