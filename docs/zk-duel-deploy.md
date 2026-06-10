# ZK Wordle Duel — deployment & real-device runbook (M5)

The trustless duel is code-complete and tested (M1–M4). This is the operator
runbook to take it live: deploy the contracts, verify the pinned dictionary root,
publish the answer list the client proves against, and validate real-device
mobile proving + a full on-chain duel.

> **Steps marked 🧑 require a human** (broadcasting transactions with a funded key,
> or testing on a physical phone). Everything else is reproducible from the repo.

## 0. What's already done (M1–M4)

- `contracts/zk/WordleDuel.sol` — match manager + escrow + settlement (28 tests).
- `contracts/zk/WordleVerifier.sol` — generated UltraHonk verifier (9 inputs).
- `circuits/` — circuit + proof fixtures; `circuits/artifacts/wordle_feedback.json`
  is the committed ACIR the client proves with.
- `src/lib/duel/` — client SDK (matchId, commitment, Merkle membership, proving),
  cross-checked against the contract/circuit in `bun test`.
- `script/DeployWordleDuel.s.sol` — deploy script; `DICT_ROOT` is pinned and
  CI-guarded (`test/zk/DictRoot.t.sol`).

## 1. Prerequisites

```bash
# toolchain (see circuits/README.md for pinned versions)
forge --version          # Foundry
nargo --version && bb --version   # only needed to re-derive/verify artifacts

# env
export DEPLOYER_ADDRESS=0x...          # 🧑 a funded deployer (Safe or EOA)
export ERC20_LIFT=0x5F99a795dD2743C36D63511f0D4bc667e6d3cDB5   # Circles v2 Hub lift
export DUEL_TOKEN=0x...                 # the Circles group inflation ERC20 (s-gCRC)
export RPC_URL=https://rpc.chiadochain.net   # Chiado first; then Gnosis (chain 100)
```

The duel uses one pinned staking token (see `WordleDuel.token`) — use the same
PvP group token the existing same-word PvP stakes, or a dedicated duel group.

## 2. Pre-flight: verify artifacts in sync

The on-chain `DICT_ROOT`, the circuit, the committed verifier, and the SDK must
all agree. CI enforces most of this; run it before deploying:

```bash
forge test --match-path "test/zk/*"     # verifier + duel + real-proof + DictRoot
bun test src/lib/duel/                  # SDK == circuit/contract values
```

To re-derive from scratch (only if you changed the circuit) follow
`circuits/README.md`, then confirm `bun run circuits/scripts/build-tree.ts react`
prints `dictionary_root = 0x0984b03ac65fe9e4710ce7fb30f53d292b0d03f812b247ef32764d6018655f87`
— the value pinned in `script/DeployWordleDuel.s.sol` and `WordleDuel`.

## 3. 🧑 Deploy (Chiado testnet first)

```bash
forge script script/DeployWordleDuel.s.sol:DeployWordleDuelScript \
  --rpc-url "$RPC_URL" --broadcast --verify
```

Records the `Verifier` and `WordleDuel` addresses (logged). The verifier (~17.8 KB)
deploys as its own contract; `WordleDuel` (~8 KB) points at it. Both are well
under EIP-170.

After Chiado passes the §5/§6 checks, repeat against Gnosis
(`RPC_URL=https://rpc.gnosischain.com`, chain 100) and verify on Gnosisscan.

## 4. 🧑 Post-deploy verification

```bash
# DICT_ROOT on-chain matches the pinned root
cast call $WORDLE_DUEL "DICT_ROOT()(bytes32)" --rpc-url "$RPC_URL"
#   => 0x0984b03ac65fe9e4710ce7fb30f53d292b0d03f812b247ef32764d6018655f87

# token + verifier wired correctly
cast call $WORDLE_DUEL "token()(address)"    --rpc-url "$RPC_URL"
cast call $WORDLE_DUEL "verifier()(address)" --rpc-url "$RPC_URL"
```

## 5. Publish the answer list (client dependency)

The client builds the Merkle membership path from the **ordered public answer
list**. It is already pinned on IPFS (same list the daily game uses):

```
CID:  QmWaw2pGNQJqQmyWTeoaAJcMygUdSj69Dxq8v422HjmPBa
URI:  ipfs://QmWaw2pGNQJqQmyWTeoaAJcMygUdSj69Dxq8v422HjmPBa
Hash: 0xed01643704d9284f12c5b5fb16717cffa1a2cf4ed0cc01ac6274bc63df2b266a  (keccak of concatenated 5-byte words)
```

The duel client must load this exact list (order matters — it defines leaf
indices and the `DICT_ROOT`) and pass it to `membershipFor` / `generateFeedbackProof`.
Do **not** reuse `src/lib/words.server.ts` directly: it is server-only to keep the
daily game's answer non-trivial to compute client-side. Serve the duel answer list
via a dedicated route or bundle a public copy, and guard it with a test that the
recomputed root equals `DICT_ROOT` (mirrors `src/lib/duel/tree.test.ts`).

## 6. 🧑 Real-device mobile proving (the last feasibility gate)

Desktop single-thread WASM proving is ~400 ms (see `circuits/README.md`); the open
question is real phones. Test on at least:

- **iOS Safari** (the strict WASM/memory case)
- **Android Chrome / WebView** (the Circles miniapp host)

Procedure: load a page that lazily `import("@/lib/duel/prove")` and times
`generateFeedbackProof` for one guess. Record:

| Device / browser         | proving time | peak memory | pass?   |
| ------------------------ | ------------ | ----------- | ------- |
| iPhone (Safari)          |              |             | ≲ ~10 s |
| Android (Chrome/WebView) |              |             | ≲ ~10 s |
| low-end Android          |              |             | ≲ ~10 s |

Watch for: WASM out-of-memory on low-end devices, multi-threading (cross-origin
isolation / COOP-COEP headers needed for bb.js threads — single-thread avoids
this but is slower). If a device blows the budget, fall back options are in
`docs/zk-duel-protocol.md` §7 (hybrid relay, lazy/dispute-only proving, recursion).

## 7. 🧑 End-to-end on-chain duel (two wallets)

Acceptance test with two funded wallets A and B on the deployed contract:

1. A picks a secret word + random salt + nonce; computes `matchId = deriveMatchId(A, nonce)`
   and `commitmentA = commitWord(secret, salt, matchId)`; `createMatch(nonce, commitmentA, stake)`.
2. B does the same and `joinMatch(matchId, commitmentB)`.
3. A `submitGuess`; B `generateFeedbackProof` then `submitFeedback(matchId, feedback, proof)`. Repeat per turn on each track.
4. On solve/timeout, anyone `settle(matchId)`; winners `withdraw()`.

Validate each branch from `docs/zk-duel-protocol.md` §4 on-chain: a normal solve,
an owner-forfeit timeout (don't answer → opponent `settle`s and wins), a
neither-solves draw (refund each), and that a proof from one match is rejected in
another.

## 8. Wiring notes

- **UI (the M4 follow-up):** a client component that lazily imports the prover and
  builds txs via `src/lib/duel/abi.ts`, sent through the Circles miniapp wallet
  (`@aboutcircles/miniapp-sdk`, as the existing PvP does).
- **Match discovery:** v1 is create-by-id / join-by-id (no lobby). For a browsable
  lobby, index `MatchCreated`/`MatchJoined`/`MatchSettled` events (the existing
  arak indexer + backend pattern, or a thin read API). Mirror the escrow's config
  wiring in `deployment/` if hosting on DAppNode.
- **No backend in the settlement path** — settlement is fully on-chain; any backend
  is convenience-only (discovery/history), never a referee.
