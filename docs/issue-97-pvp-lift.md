# Issue #97 — Auto-mint ("lift") the group token when joining PvP

Research notes + implementation plan for letting a player enter PvP when they hold
only **personal CRC**, by minting + wrapping into the stake token (`s-gCRC`) inside
the same batched submission as `approve` + `join`.

## Status — implemented & fork-verified (2026-05-30)

Implemented across `src/lib/contract.ts`, `src/lib/circles.ts`,
`src/components/PvpGame.tsx`, with tests in `test/PvpLift.fork.t.sol` (Gnosis fork)
and `src/lib/contract.test.ts` (encoder/selector cross-check). What the fork test
settled against live mainnet state:

- **§3a (amount math) — confirmed real.** The naive static→demurrage→static
  round-trip lands **1 wei short** of the stake (`999999999999999 < 1e15`).
  `staticToDemurrage` now bumps the demurraged amount by the static deficit until
  the wrap covers the stake. The fork test mirrors this and asserts minted ≥ stake.
- **§3b (group trust) — confirmed binding right now.** `groupMint` reverts with
  `CirclesErrorAddressUintArgs(group, avatar, 0x20)` even for a wallet that minted
  s-gCRC in the past — the group's trust has lapsed. So **inline self-lift does NOT
  currently work for arbitrary players**; the group must `trust(player)` first.
  The negative fork test locks this in; the UI surfaces `NoCirclesError` distinctly.
- **§3c (operator approval) — resolved: NOT needed.** Self `groupMint`+`wrap`
  succeed with no `setApprovalForAll`. The batch is just the 4 calls (no step 0).
- **Group/Hub plumbing — avoided.** The group avatar is read on-chain from
  `token.avatar()`, so no `/api/config` or env change was needed.

Canonical addresses used (verified on-chain): Hub
`0xc12C1E50ABB450d6205Ea2C3Fa861b3B834d13e8`, ERC20Lift registry
`0x5F99a795dD2743C36D63511f0D4bc667e6d3cDB5`, group
`0xC19BC204eb1c1D5B3FE500E5E5dfaBaB625F286c`, s-gCRC / `PVP_TOKEN`
`0xeeF7B1f06B092625228C835Dd5D5B14641D1e54A`.

## 1. What "lift" actually is

> **Corrected on-chain addresses (verified 2026-05-30 against Gnosis):**
> The issue's group address `0xC19BC204eb1c1D5B3FE32072641430656D3F7c064` is
> **malformed (41 hex digits)**. The real group avatar — read from
> `PVP_TOKEN.avatar()` — is **`0xC19BC204eb1c1D5B3FE500E5E5dfaBaB625F286c`**
> (`symbol = s-gCRC`). It `isGroup() == true`, with
> mint policy `0xCDFc5135AEC0aFbf102C108e7f5C8A88C6112842` and
> treasury `0x61CC0D966A97d716Ec5Cbe02095d45aA22B28b1d`.
> Hub `0xc12C1E50ABB450d6205Ea2C3Fa861b3B834d13e8` and
> `PVP_TOKEN` `0xeef7b1f06b092625228c835dd5d5b14641d1e54a` from the issue are valid.

There is **no function literally named `lift`** in either Circles SDK
(confirmed against the Node SDK `aboutcircles/circles-sdk` and the Rust crate
`aboutcircles/circles-sdk-rs`). What we colloquially call "lifting a token" is a
two-step composition on the **Circles v2 Hub** (`0xc12C1E50ABB450d6205Ea2C3Fa861b3B834d13e8`):

1. **`groupMint`** — contribute personal CRC (ERC1155) as collateral and receive
   the **group token as ERC1155** (`gCRC`), 1:1 in demurraged units (subject to the
   group's mint policy / fee).
2. **`wrap(..., type = 1)`** — wrap the group ERC1155 into the **static /
   inflationary ERC20** wrapper, i.e. `s-gCRC` — which _is_ our `PVP_TOKEN`
   (`0xeef7b1f06b092625228c835dd5d5b14641d1e54a`).

The PvP stake (`approve`/`join`) is denominated in `s-gCRC`, so both steps are
required to go from "only personal CRC" to "can stake".

### Exact ABI (both SDKs agree)

```solidity
// Circles v2 Hub
function groupMint(
    address _group,
    address[] calldata _collateral,
    uint256[] calldata _amounts,
    bytes  calldata _data            // typically 0x
) external;

function wrap(
    address _avatar,                  // = the group address
    uint256 _amount,                  // demurraged group-CRC amount to wrap
    uint8   _type                     // 0 = Demurrage ERC20, 1 = Inflationary/static ERC20
) external returns (address);         // the ERC20 wrapper (== PVP_TOKEN, already deployed)
```

## 2. The full batched transaction

The miniapp SDK's `sendTransactions(Transaction[])` takes a list of **statically
pre-encoded** `{ to, data, value }` calls. It does **not** chain return values
between calls, so every target/arg must be known up front. That is fine here:

- `wrap` returns the ERC20 address, but the wrapper for `(group, type=1)` is
  **already deployed** and equals the known `PVP_TOKEN`. So `approve` can target
  `PVP_TOKEN` directly without reading `wrap`'s return value.
- The whole thing fits in **one `sendTransactions` call**:

```
0. Hub.setApprovalForAll(Hub, true)                    to: HUB   (see §3c — may be required)
1. Hub.groupMint(group, [player], [wrapAmount], 0x)    to: HUB
2. Hub.wrap(group, wrapAmount, 1)                       to: HUB   → mints s-gCRC to player
3. PVP_TOKEN.approve(escrow, stake)                    to: PVP_TOKEN
4. escrow.join(resolver, PVP_TOKEN, stake, capacity)  to: escrow
```

Steps 3–4 are exactly today's batch (`encodeApprove` + `encodeJoin` in
`src/lib/contract.ts`, sent via `joinPvpGame` in `src/lib/circles.ts`, called from
`findMatch` in `src/components/PvpGame.tsx` ~L140). We **prepend** the lift steps
(0–2) only when the player's `s-gCRC` balance `< stake`. Whether step 0 is needed
is the one thing to pin down on a fork (see §3c).

## 3. Two subtleties that will bite us

### 3a. Demurraged vs. static units (amount math)

`stake` is in **static** `s-gCRC` units, but `groupMint`/`wrap` operate in
**demurraged** units. Wrapping `X` demurraged group-CRC yields
`toInflationary(X, today) > X` static tokens, and the factor changes daily. So:

```
wrapAmount (demurraged) = staticToDemurrage(stake, today)
```

We must compute `wrapAmount` with the **same conversion the contract uses** to
avoid ending up a few wei short of `stake`. Options, in order of robustness:

- Read the Hub's on-chain conversion (`convertInflationaryToDemurrageValue` /
  `convertDemurrageToInflationaryValue`) at the current day, **or**
- mirror the SDK's demurrage utility (this is the main reason to "mirror the SDK"
  rather than hand-roll the factor), **or**
- mint/wrap a small buffer over `stake` and approve exactly `stake`.

This is the single most important correctness detail and must be covered by the
fork test (assert post-wrap `s-gCRC` balance `>= stake`).

### 3b. Group-trust prerequisite (this is what blocks "players as well")

`groupMint` only succeeds if **the group trusts the collateral avatar** (the
player's personal CRC) — the group's mint policy enforces this. Consequences:

- If the PvP group does **not** trust an arbitrary player's personal avatar,
  step 1 reverts and the player cannot self-lift no matter what we batch.
- So "players as well" depends on the group's trust configuration:
  - **Open/permissive policy** → any personal CRC can be minted → inline lift works for everyone.
  - **Restricted policy** → players must be trusted by the group first (a separate
    `Hub.trust(player)` from the group/bot), which is a governance action, not part
    of the join batch.

**Action:** confirm the PvP group's mint policy / trust set before assuming the
inline-lift covers all players. The issue's "can't play" message should also
distinguish _"no CRC at all"_ from _"your CRC isn't trusted by this group"_.

### 3c. ERC1155 operator approval — RESOLVED: not needed

The fork test ran the batch with no `setApprovalForAll` and both `groupMint` and
`wrap` succeeded. For a self-call the Hub moves the caller's own ERC1155 balance,
so no operator approval is required. The batch is the 4 calls only; no step 0.

## 4. The bot

The matchmaking bot's Safe stakes too. Same requirement: it needs `s-gCRC`.
Either pre-fund the bot Safe with `s-gCRC`, or have the bot run the same
lift batch. Since the group presumably trusts the bot/its own collateral, the
bot path is the easy case; document whichever we choose. (Issue task: "verify the
bot Safe has sufficient group tokens or document that it must be pre-funded".)

## 5. Testing strategy (before deploy)

Goal stated by the issue author: **a Foundry fork test, AND confirmation that the
SDKs build the same payload that the fork test exercises.** Concretely:

1. **Foundry fork test** (`test/`, fork Gnosis at a recent block):
   - Take a fresh EOA that holds only personal CRC (impersonate a known CRC holder
     via `vm.prank`/`deal`-equivalent, or mint via the Hub in-fork).
   - Execute the 4-call batch `groupMint → wrap → approve → join` against the live
     Hub / `PVP_TOKEN` / escrow addresses.
   - Assert: post-wrap `s-gCRC` balance `>= stake`; `join` succeeds and emits the
     escrow's join event; the demurrage→static math leaves no shortfall.
   - Add a negative test: a player whose personal CRC the group does **not** trust
     → `groupMint` reverts (locks in the 3b prerequisite).

2. **SDK payload cross-check** (so the fork test isn't testing calldata the app
   would never actually send):
   - A small script builds the lift calldata three ways and asserts byte-equality:
     (a) our viem encoders in `src/lib/contract.ts`, (b) the **Node** SDK
     (`@aboutcircles/sdk` `groupMint` + `wrap`), (c) the **Rust** SDK
     (`circles-sdk` `group_mint` + `wrap`) — at minimum (a) vs (b); (c) as an
     additional confidence check.
   - Feed the _same_ calldata bytes into the Foundry test (e.g. via a fixture file
     or `vm.ffi`) so the test provably runs the exact payload the SDKs produce.
   - Note: `@aboutcircles/sdk` is **not currently a dependency** (only
     `@aboutcircles/miniapp-sdk@0.1.30` is installed, and it's just a tx relay with
     no mint/wrap helpers). Mirroring the SDK means either adding `@aboutcircles/sdk`
     as a dev dependency for the cross-check, or porting its demurrage conversion +
     encoders into our own `contract.ts`.

## 6. Implementation tasks (mapped to files)

- `src/lib/contract.ts`
  - Add `hubAbi` with `groupMint` + `wrap` and `encodeGroupMint(...)`,
    `encodeWrap(...)`.
  - Add a balance reader for `PVP_TOKEN` (ERC20 `balanceOf`) and the
    demurrage↔static conversion (read on-chain or port the SDK util) to compute
    `wrapAmount` from `stake`.
- `src/lib/circles.ts`
  - Extend `joinPvpGame` (or add `joinPvpGameWithLift`) to optionally prepend
    `[groupMint, wrap]` to the `[approve, join]` batch in one `sendTransactions`.
- `src/components/PvpGame.tsx` (`findMatch`, ~L140)
  - Check `s-gCRC` balance; if `< stake`, include the lift; surface clear errors:
    "no CRC to stake" vs "your CRC isn't trusted by this group".
- `test/` (Foundry)
  - Fork test for the full batch + negative trust test, fed by SDK-generated calldata.
- **Config plumbing (new work):** `/api/config` (`src/app/api/config/route.ts`) is a
  thin proxy to the Rust backend (`${API_URL}/api/config`) and currently returns only
  `{ escrowAddress, token, amount, resolver, capacity, pvpEnabled }` — it does **not**
  expose the `group` or `hub` addresses. To build the lift client-side we must either
  (a) add `group` + `hub` to the Rust backend's `/api/config` payload, or
  (b) inline them on the client via `NEXT_PUBLIC_HUB` / `NEXT_PUBLIC_PVP_GROUP`.

## 7. Open questions to confirm before building

1. **Group mint policy / trust:** does the PvP group trust arbitrary players'
   personal CRC, or only a curated set? (Decides whether inline-lift works for all
   players or needs a prior `trust` step.) — _blocking for "players as well"._
2. **Stake denomination buffer:** exact-amount conversion vs. mint-with-buffer —
   pick based on the SDK's rounding behavior.
3. **Bot funding:** pre-fund the bot Safe with `s-gCRC`, or have the bot lift too?
4. **Cross-check depth:** Node SDK only, or Node + Rust byte-equality in CI?
