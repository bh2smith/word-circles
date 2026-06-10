# ZK Wordle Duel — Protocol & Contract Spec

**Status:** design / spec (no code yet). Target: Gnosis Chain (id 100), Solidity
^0.8.24, Foundry. Builds on the completed ZK spike (`circuits/`,
`contracts/zk/WordleVerifier.sol`, PR #186) — cryptographic feasibility is
already proven (GO). This doc designs the **game protocol + contracts** around
that verifier.

A fully **trustless, chain-only** two-player duel: each player commits their own
secret answer word, then they guess each other's. The chain is escrow + message
bus + referee + settlement. **No backend in the settlement path.**

## How this differs from today's PvP

The live PvP (`WordCirclesEscrow.sol`) is a **same-word race** settled by a
**trusted resolver ECDSA signature** (`resolve(gameId, winners, amounts, sig)`).
The duel is a **mutual** game (each picks own word) settled by **on-chain ZK
verification** — the contract itself is the referee. We reuse the escrow's
_patterns_ (token validation, `SafeERC20`, `ReentrancyGuard`, a `settled`-style
guard, deterministic ids) in a fresh contract, not the resolver paradigm.

## The verifier we wire in

`contracts/zk/WordleVerifier.sol` → `HonkVerifier.verify(bytes proof, bytes32[]
publicInputs) returns (bool)` (view). Circuit public inputs (8, ordered):
`[commitment, dictionary_root, guess0..guess4, feedback]`. `feedback` is packed
base-4 (5 tiles, LSB-first; absent=0, present=1, correct=2). **`feedback == 682`
means solved** (all five correct: `2·(1+4+16+64+256)`). The proof binds the
feedback to the committed word, so the contract supplies `guess`/`commitment`/
`dictionary_root` from storage and the SNARK forces `feedback` to be the true
score.

---

## 1. Turn structure — **two independent tracks** (recommended)

Each player owns one secret; each runs an **independent guess sequence against
the opponent's word**. Track where **A guesses B's word** is answered by **B's**
feedback proofs, and vice-versa. Within a track there is a strict micro-step:
**guesser posts plaintext guess → owner posts feedback proof → next guess.** A
guesser cannot stack a second guess before the prior is answered (bounds owner
work to one outstanding proof/track and removes a griefing vector).

Why independent tracks over global strict-alternation:

- **No deadlock.** Strict global alternation lets one offline player freeze both
  tracks. Independent tracks localize a stall to one player's deadline.
- **Matches the proven async settlement rules** (fewest guesses → most greens →
  most oranges → split) which compare two independent performances.
- **Clean griefing economics:** a stalling owner only forfeits _their own_
  defense, never the opponent's progress.

## 2. State machine

`enum Status { Open, Active, Settled, Cancelled }` (per-track liveness is derived
from `solved`/`guessCount`/deadlines, not a global enum). Resolution is always an
explicit call, never implicit.

| From   | Call                                         | Effect                                                                                                                                                                                                                                   |
| ------ | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| —      | `createMatch(commitmentA, stake)`            | Status=Open; escrow stake A; `createDeadline = now + JOIN_WINDOW`. `dictRoot` is an immutable constant (§5), not a parameter.                                                                                                            |
| Open   | `cancelMatch(id)` (A, after JOIN_WINDOW)     | refund A; Cancelled.                                                                                                                                                                                                                     |
| Open   | `joinMatch(id, commitmentB)`                 | escrow stake B; Status=Active.                                                                                                                                                                                                           |
| Active | `submitGuess(id, guess[5])`                  | guesser posts plaintext guess; requires no outstanding guess on their track; range-check each letter `< 26` (**mandatory** — else feedback is unprovable and bricks the track); `feedbackDeadline = now + MOVE_TIMEOUT`; `guessCount++`. |
| Active | `submitFeedback(id, track, feedback, proof)` | word-owner answers pending guess; verify; record feedback, update green/orange tallies; if `682` set `solved`+`solvedAtGuess`; clear deadline.                                                                                           |
| Active | `settle(id)`                                 | once a terminal condition holds; apply tiebreak; pay out; Settled.                                                                                                                                                                       |
| Active | `claimTimeout(id, track)`                    | if a track's `feedbackDeadline` passed with a pending guess → that track's **guesser wins pot by forfeit** (or tiebreak if both tracks timed out — §4).                                                                                  |

## 3. Storage layout (gas-lean)

Only enough state to (a) verify the next proof, (b) compute tiebreak, (c) enforce
timeouts. Full transcript lives in **events**, not storage.

```solidity
struct Track {            // indexed by GUESSER
    uint8   guessCount;
    uint8   greens;       // cumulative CORRECT tiles (tiebreak)
    uint8   oranges;      // cumulative PRESENT tiles (tiebreak)
    uint8   solvedAtGuess;
    bool    solved;
    bool    pendingGuess;
    uint8[5] guess;       // current pending plaintext guess
    uint64  feedbackDeadline;
}
struct Match {
    address playerA; address playerB; address token;
    uint256 stake;                    // pot = 2*stake
    bytes32 commitmentA;              // A's word; B guesses it (answered on trackB)
    bytes32 commitmentB;              // B's word; A guesses it (answered on trackA)
    uint64  createDeadline; Status status;
    Track   trackA;  // A is guesser → answered against commitmentB by B
    Track   trackB;  // B is guesser → answered against commitmentA by A
}
mapping(bytes32 => Match) public matches;
bytes32 public immutable DICT_ROOT;   // pinned (§5)
```

Constants: `MAX_GUESSES=6`, `FEEDBACK_SOLVED=682`, `JOIN_WINDOW=1h`,
**`MOVE_TIMEOUT=24h`** (fully-async casual play; a match may span days, but a
non-answering owner still forfeits). `Match` ≈ 9–10 slots — cheap on Gnosis.

## 4. Timeout & griefing (the hard part)

Two per-action timers; **no whole-game wall clock** (exploitable + unnecessary
with independent tracks). There is deliberately **no timeout on the guesser** — a
guesser who stops simply stops improving, so stalling never helps the staller.

| Vector                                     | Mitigation                                                                                                                                                                                                                                     |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Losing owner refuses to prove feedback** | After `feedbackDeadline`, **anyone** calls `claimTimeout(id, track)` → that track's **guesser wins the whole pot by forfeit.** Refusing to answer = guaranteed total loss, strictly worse than answering honestly. This is the core deterrent. |
| **Abandons after seeing they lose**        | Manifests as (a) not answering → above (guesser wins), or (b) not guessing further → harmless (opponent wins on own completion/timeout). Abandonment ⇒ loss either way.                                                                        |
| **No second player**                       | After `JOIN_WINDOW`, `cancelMatch` refunds A fully (no rake on a never-started match).                                                                                                                                                         |
| **Mutual stall (both tracks expired)**     | `claimTimeout` first checks if the _other_ track is also expired+pending; if yes → it's a symmetric no-progress draw → **refund each their stake** (not "first poker wins"), removing any front-run incentive.                                 |
| **One races ahead while other offline**    | Fine — finishing your track still requires the opponent to finish / exhaust / time out before `settle`. No shared turn token, no deadlock.                                                                                                     |
| **Gas / who pokes**                        | `settle`/`claimTimeout` are **permissionless** (beneficiary pokes); Gnosis gas is sub-cent so no keeper economics. Acting players pay their own `submitGuess`/`submitFeedback`.                                                                |

**Payout rules** (`pot = 2*stake`). A **win** happens only when someone solves or
the opponent forfeits; if **nobody solves**, it's a draw and stakes are refunded
(symmetric, trustless — the locked decision):

1. **Single forfeit** — one track times out (owner won't answer) while it's not a
   mutual stall → that track's **guesser wins full pot** (grief punishment).
2. **Both solved** → lower `solvedAtGuess` wins; tie → most greens → most oranges
   → split 50/50.
3. **One solved, other exhausted `MAX_GUESSES`** → solver wins.
4. **Neither solved (both exhausted guesses)** → **refund each their stake** (draw).
5. **Mutual stall (both tracks timed out, neither solved)** → **refund each their
   stake** (draw).

The greens/oranges tiebreak applies **only** to disambiguate two solvers on equal
guess counts (case 2); when nobody solved we refund rather than crown a winner on
partial tallies. **No rake in v1** — pure pot redistribution. All payouts via
`SafeERC20.safeTransfer`, `nonReentrant`, `status=Settled` written **before**
transfers (CEI), as in `WordCirclesEscrow.resolve`.

## 5. Threat model

- **Proof replay across matches** — the current commitment `Poseidon2(secret,
salt)` does **not** bind `(matchId, player)`. A proof could be replayed in
  another match reusing the same `(secret, salt, guess)`. **Recommended fix
  (circuit change):** add `match_binding: pub Field` and fold it into the
  commitment preimage; the contract forces it to the stored `matchId`/owner, so
  cross-match replay fails. Public inputs 8 → 9; regenerate the verifier. (The
  no-change alternative — enforce fresh per-match salt — is unenforceable on-chain
  since salt is private.) **This is the single most important crypto change.**
- **Malicious `dictRoot`** — do **NOT** accept a caller-supplied root (a player
  could commit a 1-word "dictionary" and trivially solve). Pin `DICT_ROOT` as an
  immutable constant = the Poseidon Merkle root of ANSWERS
  (`0x0984b03ac65fe9e4710ce7fb30f53d292b0d03f812b247ef32764d6018655f87`, already
  in `circuits/wordle_feedback/src/main.nr`). Analog of `WordCommitment.wordListHash`.
- **Committing a non-dictionary word** — impossible to exploit: the circuit's
  membership assertion fails, so the cheater can never produce a valid feedback
  proof, times out, and **auto-loses every track by forfeit.** The timeout rule
  _is_ the anti-cheat for bad commitments.
- **Front-running** — guesses are public anyway (no MEV); feedback is SNARK-bound
  (can't forge a different value); re-submitting the same proof is idempotent-
  guarded by `pendingGuess`.
- **Double settlement / reentrancy** — single `Status` flip before transfers;
  `nonReentrant`; all paths `require(status==Active)`.
- **Owner answers a different guess** — impossible: `guess` public inputs are
  forced from the stored pending guess, not the submitter.
- **Reveal-by-proof leakage** — each feedback leaks info about the secret (that's
  the game); no privacy promised beyond match end.

**Guess validity:** the guesser's word is _not_ proven to be a dictionary word.
Recommendation: **allow non-dictionary guesses** — a non-word only wastes the
guesser's own turn (can't score 682 unless it equals the secret, which is a real
word). Only the cheap on-chain `< 26` range-check is mandatory (out-of-range
bytes would make feedback unprovable). Client validates locally for UX.

## 6. Contract decomposition

**Write fresh — do not extend `WordCirclesEscrow`** (different settlement
paradigm). New files:

- `contracts/zk/WordleDuel.sol` — MatchManager + escrow + verifier wiring. Holds
  `IERC20Lift`, immutable `DICT_ROOT`, immutable verifier address (deploy the
  ~17.8KB verifier separately and pass its address, keeping `WordleDuel` under
  EIP-170). Functions: `createMatch`, `joinMatch`, `cancelMatch`, `submitGuess`,
  `submitFeedback`, `settle`, `claimTimeout`, + views.
- `contracts/zk/IWordleVerifier.sol` — `verify(bytes, bytes32[]) view returns
(bool)` so `WordleDuel` depends on an interface, not the generated file.
- `test/zk/WordleDuel.t.sol` — reuse `MockToken`/`MockERC20Lift` from
  `test/WordCirclesEscrow.t.sol`; a `MockVerifier` for timeout/settle branches; a
  real `circuits/target` proof for the happy path (as `WordleVerifier.t.sol`).
- `script/DeployWordleDuel.s.sol` — deploy verifier + duel; assert `DICT_ROOT`
  matches `circuits/target`.

Test cases: happy path (A solves), token validation, join/cancel/refund,
owner-stall→guesser-wins, both-timeout tiebreak/split, both-solved fewest-guesses,
tie split, solver-beats-exhausted, double-settle revert, replay guard (post
binding change), stacked-guess revert, out-of-range byte revert, reentrancy,
tampered-feedback rejected.

## 7. Phased plan

Spike already gives: working verifier (2.27M gas, 17.8KB), accept/reject proven,
~380ms WASM proving, scoring pinned to `game.server.ts`, the ANSWERS root.

- **M0 — Decisions** (§8). Blocks circuit/verifier shape.
- **M1 — Core contract + MockVerifier:** all state, escrow, timeouts, settlement;
  full test plan minus real-proof cases. _Where the griefing rigor is proven._
- **M2 — (Optional) match-binding circuit change:** edit `main.nr`, regen
  verifier, bump public-input arity in `WordleVerifier.t.sol`.
- **M3 — Real verifier integration:** wire `HonkVerifier`; real-proof happy-path +
  replay-guard tests; deploy script; gas-report `submitFeedback`.
- **M4 — Client proving:** browser/mobile WASM prover builds `(proof, feedback)`
  from local secret+salt+merkle path; client builds the txs; reuse
  `game.server.ts` encodings.
- **M5 — Real-device + testnet:** deploy to Chiado/Gnosis, run an end-to-end duel
  on a phone with two wallets; validate every timeout branch on-chain.

## 8. Decisions (locked)

1. **Match-binding circuit change — YES.** Add `match_binding: pub Field` folded
   into the commitment; contract forces it to `matchId`/owner. Closes cross-match
   replay. Public inputs 8→9; regenerate the verifier (M2).
2. **Independent tracks** (not strict alternation).
3. **`MOVE_TIMEOUT` = 24 h** per pending feedback — fully-async casual play.
4. **Both-timeout / neither-solves → refund each their stake** (symmetric,
   trustless). Deliberate divergence from the async doc's "protocol retains funds."
5. **No rake in v1** (pure pot redistribution).
6. **Owner pays gas** for feedback proofs (~sub-cent on Gnosis); no relayer in v1.
7. **`MAX_GUESSES` = 6.**
8. **Matchmaking:** v1 create-by-id + join-by-id; port lobby auto-pairing later.
