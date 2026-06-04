# Multi-group PvP & group onboarding

How Word Circles supports PvP across several Circles groups, and how players are
onboarded into a group so they can play. Implements
[issue #135](https://github.com/bh2smith/word-circles/issues/135).

## Concept

The escrow (`contracts/WordCirclesEscrow.sol`) is group-agnostic — it accepts any
token where `erc20Lift.erc20Circles(1, avatar) == token`. So "which group(s) can
you stake" is purely a backend/bot/frontend decision, no contract redeploy.

A **lobby** is one group's wrapper token + stake: an independent
`(resolver, token, amount, capacity)` bucket. The set of lobbies a given player
sees is:

```
visible = configured_lobbies                                  # PVP_LOBBIES
        ∩ { lobby : bot.balanceOf(lobby.token) ≥ 2 × amount } # bot-funded (headroom)
        ∩ { lobby : player is a member of lobby.group }       # membership
```

If `visible` is empty the PvP section is not rendered at all (no tab, no `/pvp`).
This gates **visibility only** — human-vs-human within a visible group is
unchanged; the bot is a guaranteed fallback opponent. PvP shows iff
`PVP_ENABLED && visible.length > 0`.

Consequences:

- **Fund what you want filled.** An unfunded lobby is _hidden_, not left waiting.
  "Which groups do we fund" is directly "which groups can players enter."
- **Degrades gracefully.** If the bot's balance drops below stake everywhere,
  every player sees `visible = []` and PvP vanishes until the bot is refunded.
- The 2× threshold gates _visibility_; the bot still _joins_ an existing waiting
  lobby at ≥ 1× stake.

## Configuration

### `PVP_LOBBIES` (JSON)

A JSON array, hand-written into the Dappnode/Vercel env. One entry per group:

```json
[
  {
    "name": "WordGames",
    "group": "0xb84ea90430c98ff314b803a036c9ca745b797932",
    "token": "0x872e67dBBF6d76A7484fcA6C4B99053334Bb6C0E",
    "amount": "100000000000000000",
    "capacity": 2
  },
  {
    "name": "Gnosis",
    "group": "0xc19bc204eb1c1d5b3fe500e5e5dfabab625f286c",
    "token": "0xeeF7B1f06B092625228C835Dd5D5B14641D1e54A",
    "amount": "100000000000000000",
    "capacity": 2
  },
  {
    "name": "Berlin Full Node",
    "group": "0xeb614ef61367687704cd4628a68a02f3b10ce68c",
    "token": "0x0d8c4901Dd270Fe101B8014A5dbECC4e4432eB1E",
    "amount": "100000000000000000",
    "capacity": 2
  },
  {
    "name": "Metri Core Group",
    "group": "0x86533d1ada8ffbe7b6f7244f9a1b707f7f3e239b",
    "token": "0x7147A7405fCFe5CFa30c6d5363f9f357a317d082",
    "amount": "100000000000000000",
    "capacity": 2
  }
]
```

| Field      | Meaning                                                                          |
| ---------- | -------------------------------------------------------------------------------- |
| `name`     | Display name (also the picker label fallback).                                   |
| `group`    | Circles group avatar. Intersected with the player's memberships.                 |
| `token`    | The group's s-gCRC wrapper. Validated at startup vs `erc20Circles(1, group)`.    |
| `amount`   | Per-player stake, **wei** as a decimal string. `0.1 CRC` = `100000000000000000`. |
| `capacity` | Players per game (optional, default `2`).                                        |

Notes:

- It's safe to list lobbies you haven't funded yet — they stay hidden until the
  bot holds ≥ 2× their stake. Funding, not the env, is the rollout control.
- The wrapper for a group is resolved by
  `cast call <ERC20_LIFT> "erc20Circles(uint8,address)(address)" 1 <group>`
  (`ERC20_LIFT` = `0x5F99a795dD2743C36D63511f0D4bc667e6d3cDB5`). On boot the bot
  validates each lobby and logs an error on mismatch (catches typos).
- Cut over from the old `PVP_TOKEN` / `PVP_AMOUNT` / `PVP_CAPACITY` — those are
  removed.

### `bot_funded` is live, not env

The bot reads `balanceOf(token)` for each lobby every tick and publishes the set
of funded tokens (≥ 2× stake) into shared state. `GET /api/config` stamps each
lobby's `botFunded` from that set — **no on-chain read on the request path**. On
cold start (before the first tick) the set is empty, so everything is
`botFunded:false` until the bot ticks (safe default).

## Group onboarding (`/api/group/join`)

To play PvP a player must be a **member** of a visible lobby's group (the group
trusts them on-chain) so the lobby shows and they can `groupMint` the wrapper.
After a **daily win**, a non-member is offered a one-tap "Join {group}" prompt
that calls `POST /api/group/join`.

The backend (as the group's **service**) calls the BaseGroup's
`trust(player, type(uint96).max)`. It's idempotent (skips if already a member).

### Anti-spam gate

`POST /api/group/join` requires **both**:

1. **Proof of control** — a signature over
   `"Join Word Circles PvP group\nAddress: <lowercased player>"`
   (`group_join_message` in `backend/src/lib.rs`, mirrored by `groupJoinMessage`
   in `src/lib/circles.ts`). Verified by ECDSA recovery (EOA) **or** on-chain
   ERC-1271 `isValidSignature` (Circles avatars are Safes, so the miniapp host
   signs an ERC-1271 message).
2. **Recorded play** — the address must have at least one recorded guess in the
   DB (`has_recorded_play`).

Responses: `200 {joined, alreadyMember}`, `400` bad address/signature, `401`
signature mismatch, `403` no recorded play, `503` onboarding not configured.

### Requirement: resolver is the group's service

The resolver EOA must be the onboarding group's owner or service. As the group
**owner**, run once:

```bash
cast send <GROUP_ADDRESS> "setService(address)" <RESOLVER_EOA> \
  --rpc-url $RPC_URL --account <group-owner-account>
```

Then set `GROUP_ADDRESS` to that group (usually the first `PVP_LOBBIES` entry).

> A player still needs **personal CRC** to stake even after joining (the lift
> mints the wrapper from their CRC; `NoCirclesError` messages this). The prompt
> tells empty wallets to claim daily CRC.

## Funding the bot

The bot Safe must hold each lobby's wrapper to advertise/fill it:

- ≥ **2×** stake → lobby is shown to members (`botFunded`).
- ≥ **1×** stake → bot still joins an existing waiting lobby.

Trust the bot Safe into each group (`trust(botSafe)`), then mint/wrap that
group's CRC into its wrapper for the bot Safe (or transfer the wrapper in). Keep
the default group (e.g. WordGames / Gnosis) funded to preserve the default
experience.

## Env summary

| Var                                    | Purpose                                                            |
| -------------------------------------- | ------------------------------------------------------------------ |
| `PVP_ENABLED`                          | Master kill-switch for PvP.                                        |
| `PVP_LOBBIES`                          | JSON array of per-group lobbies (above).                           |
| `GROUP_ADDRESS`                        | Onboarding group for `/api/group/join` (resolver = owner/service). |
| `BOT_ENABLED`                          | Run the matchmaking + funded-set bot.                              |
| `BOT_SAFE_ADDRESS` / `BOT_PRIVATE_KEY` | Bot Circles Safe + owner EOA.                                      |

## Verification checklist

1. Boot with all lobbies in `PVP_LOBBIES`; `GET /api/config` returns them; after
   the first bot tick each `botFunded` reflects the bot Safe's real balance.
2. Connect as a multi-group user with all lobbies funded → picker lists their
   groups. Connect as a single-group user → static label, auto-selected.
3. Member of zero _bot-funded_ groups → PvP tab hidden; direct `/pvp` shows the
   graceful unavailable message.
4. Win a daily as a non-member → "Join {group}" prompt → after trust indexes,
   PvP appears. Replaying the prompt for a member is a no-op (`alreadyMember`).
5. `POST /api/group/join` with a bad/missing signature → `401`; with no recorded
   play → `403`.
6. Drop the bot's balance on one lobby below stake → after the next tick it
   leaves `botFunded` and members of only that group stop seeing PvP.
