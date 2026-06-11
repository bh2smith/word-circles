# ZK Duel — real board feedback

## Problem

The `/zk-duel` UI only showed aggregate counts ("x green / y orange") because it
rendered `getTrack` storage, which deliberately keeps only running tile totals
plus the single *current* pending guess. Per-guess colors live only in events.

Both events are public (the ZK proof hides the *secret word*, not the feedback):

- `GuessSubmitted(bytes32 indexed matchId, address indexed guesser, uint8 guessNumber, uint8[5] guess)`
- `FeedbackSubmitted(bytes32 indexed matchId, address indexed owner, uint8 guessNumber, uint16 feedback)`

`feedback` is base-4 packed, LSB-first (2=green, 1=orange, 0=gray); `unpackFeedback` already exists.

Track mapping: A guesses on trackA / B on trackB. The *owner* answers the
*opponent's* track — B's `FeedbackSubmitted` grades trackA, A's grades trackB —
joined on `guessNumber`.

## Deployment (Gnosis, chainId 100)

- WordleDuel: `0xbfe4a990e4148c60745e8e64ed6d5c8a517bc15f`
- HonkVerifier: `0x81bb859411fa233d657ed4cfc514912bff3c4aa4`
- Deploy block: `46624922`

## Phase 1 — RPC board reconstruction (DONE)

- `abi.ts`: added the two events to `WORDLE_DUEL_ABI`.
- `frontend.ts`: `scanZkBoards()` reconstructs both colored boards from logs via
  `getContractEvents` (matchId is an indexed topic → tiny result set), chunked at
  9k blocks to stay under public-RPC range caps. Incremental from
  `lastScannedBlock` for live games; cold-starts from the deploy block.
  `loadZkBoard`/`saveZkBoard` persist to localStorage; `currentBlock()` helper.
- `ZkDuelGame.tsx`: scans boards inside the 5s refresh loop; seeds a board at
  create/join so live scans start at creation, not the deploy block. Renders both
  tracks ("Your guesses" / "Their guesses", with your own secret word shown on
  the answer track) as real `Tile` boards. Overlays the on-chain pending guess so
  a just-submitted guess shows immediately.
- `Tile.tsx`: added opt-in `size="sm"` (default unchanged) so two boards fit.

## Phase 2 — Dune bootstrap for resumed games (TODO)

Only for a game a player left and came back to (cold/cross-device/invite-link),
where the gap from creation→now may exceed RPC range limits. Live games stay on
RPC; Dune lags the chain by minutes so it must not drive the live loop.

- Server Route Handler `src/app/api/zk-duel/board/route.ts` reads `DUNE_API_KEY`
  server-side (never `NEXT_PUBLIC_`); client calls our own endpoint.
- Saved Dune query (needs `WordleDuel` ABI decoded on Dune, in progress),
  parameterized by `{{match_id}}`, returning guess + feedback rows.
- `frontend.ts`: `fetchBoardViaDune(matchId)` → seed board + `lastScannedBlock`,
  then hand off to RPC `scanZkBoards`.
- Trigger only when there is no persisted board for the match.
- Open question: per-match query (freshest) vs one cached "recent events" query
  filtered server-side (cheapest). Leaning cached for the demo.
