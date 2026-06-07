import {
  createPublicClient,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  parseAbi,
} from "viem";
import { gnosis } from "viem/chains";

export const STATS_CONTRACT =
  "0xB96413584d7a4e07cc8c238cC4baA3474C956CCF" as const;

export const statsAbi = parseAbi([
  "function recordGame(uint32 gameId, bool won, uint8 guesses)",
  "function getStats(address player) view returns (uint32 gamesPlayed, uint32 gamesWon, uint32 currentStreak, uint32 maxStreak, uint32 lastGameId, uint32[6] guessDistribution)",
]);

const publicClient = createPublicClient({
  chain: gnosis,
  transport: http(),
});

export function encodeRecordGame(
  gameId: number,
  won: boolean,
  guesses: number,
): string {
  return encodeFunctionData({
    abi: statsAbi,
    functionName: "recordGame",
    args: [gameId, won, guesses],
  });
}

// PvP matchmaking happens on-chain: a player approves the escrow for their
// stake, then calls join() with the lobby parameters from /api/config. The
// escrow pairs joiners into games and emits Created/Joined for the indexer.
export const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
]);

// Circles v2 Hub. groupMint contributes personal CRC (ERC1155) as collateral and
// mints the group token (ERC1155 gCRC); wrap converts that into the static ERC20
// (s-gCRC) that the escrow stakes. type 1 = Inflationary/static (CIRCLES_TYPE_INFLATION
// in WordCirclesEscrow). The (group, type=1) wrapper is already deployed and equals
// PVP_TOKEN, so we never need wrap()'s return value — approve() targets PVP_TOKEN.
export const HUB_ADDRESS =
  "0xc12C1E50ABB450d6205Ea2C3Fa861b3B834d13e8" as const;

export const hubAbi = parseAbi([
  "function groupMint(address group, address[] collateral, uint256[] amounts, bytes data)",
  "function wrap(address avatar, uint256 amount, uint8 circlesType) returns (address)",
  "function isHuman(address avatar) view returns (bool)",
  "function day(uint256 timestamp) view returns (uint64)",
  "function balanceOf(address account, uint256 id) view returns (uint256)",
]);

// The static ERC20 wrapper (s-gCRC == PVP_TOKEN) exposes the same demurrage math
// the Hub uses, so we convert a static stake into the demurraged amount groupMint/
// wrap expect at the current day rather than re-deriving the daily factor.
export const wrapperAbi = parseAbi([
  "function convertInflationaryToDemurrageValue(uint256 value, uint64 day) view returns (uint256)",
  "function convertDemurrageToInflationaryValue(uint256 value, uint64 day) view returns (uint256)",
  "function avatar() view returns (address)",
  "function unwrap(uint256 amount)",
]);

export const escrowAbi = parseAbi([
  "function join(address resolver, address token, uint256 amount, uint128 capacity) returns (bytes32)",
  "function getPlayerCount(address resolver, address token, uint256 amount, uint128 capacity) view returns (uint128)",
  "function isPlayerInGame(bytes32 gameId, address player) view returns (bool)",
]);

// True if `player` is already seated in the lobby's current open game, which
// means a fresh join() would revert with PlayerAlreadyJoined. This mirrors the
// escrow's on-chain gameId derivation exactly:
//
//   lobbyKey = keccak256(resolver, token, amount, capacity)
//   gameId   = keccak256(lobbyKey, playerCount / capacity)
//
// Reading the chain (rather than tracking "just played" in component state)
// makes the Play-Again guard survive a page refresh. Once the game fills, the
// counter rolls over to a new bucket and this returns false again.
export async function isPlayerInOpenGame(
  escrow: string,
  resolver: string,
  token: string,
  amount: bigint,
  capacity: number,
  player: string,
): Promise<boolean> {
  const cap = BigInt(capacity);
  const count = (await publicClient.readContract({
    address: escrow as `0x${string}`,
    abi: escrowAbi,
    functionName: "getPlayerCount",
    args: [resolver as `0x${string}`, token as `0x${string}`, amount, cap],
  })) as bigint;
  const lobbyKey = keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "uint128" },
      ],
      [resolver as `0x${string}`, token as `0x${string}`, amount, cap],
    ),
  );
  const gameId = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }],
      [lobbyKey, count / cap],
    ),
  );
  return (await publicClient.readContract({
    address: escrow as `0x${string}`,
    abi: escrowAbi,
    functionName: "isPlayerInGame",
    args: [gameId, player as `0x${string}`],
  })) as boolean;
}

export function encodeApprove(spender: string, amount: bigint): string {
  return encodeFunctionData({
    abi: erc20Abi,
    functionName: "approve",
    args: [spender as `0x${string}`, amount],
  });
}

export function encodeJoin(
  resolver: string,
  token: string,
  amount: bigint,
  capacity: number,
): string {
  return encodeFunctionData({
    abi: escrowAbi,
    functionName: "join",
    args: [
      resolver as `0x${string}`,
      token as `0x${string}`,
      amount,
      BigInt(capacity),
    ],
  });
}

const CIRCLES_TYPE_INFLATION = 1;

export function encodeGroupMint(
  group: string,
  collateral: string[],
  amounts: bigint[],
  data: `0x${string}` = "0x",
): string {
  return encodeFunctionData({
    abi: hubAbi,
    functionName: "groupMint",
    args: [
      group as `0x${string}`,
      collateral as `0x${string}`[],
      amounts,
      data,
    ],
  });
}

export function encodeWrap(avatar: string, amount: bigint): string {
  return encodeFunctionData({
    abi: hubAbi,
    functionName: "wrap",
    args: [avatar as `0x${string}`, amount, CIRCLES_TYPE_INFLATION],
  });
}

// Burn `amount` of a Circles ERC-20 wrapper, crediting the caller's personal CRC
// back as ERC-1155 in the Hub so groupMint can draw it as collateral. For a
// demurraged wrapper `amount` is demurraged (credited 1:1); for an inflationary
// wrapper it's the static amount. No approval needed — unwrap burns the caller's
// own balance. Selector 0xde0e9a3e, verified on-chain against the Circles v2
// wrapper implementation on Gnosis.
export function encodeUnwrap(amount: bigint): string {
  return encodeFunctionData({
    abi: wrapperAbi,
    functionName: "unwrap",
    args: [amount],
  });
}

// The group avatar that mints `token` (s-gCRC). Read from the wrapper itself so
// we don't need to plumb the group address through /api/config or env.
export async function getTokenAvatar(token: string): Promise<string> {
  return publicClient.readContract({
    address: token as `0x${string}`,
    abi: wrapperAbi,
    functionName: "avatar",
  });
}

export async function getErc20Balance(
  token: string,
  account: string,
): Promise<bigint> {
  return publicClient.readContract({
    address: token as `0x${string}`,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account as `0x${string}`],
  });
}

// A player's own personal CRC, held in the Hub as ERC1155 with tokenId =
// uint160(avatar). Used to tell "no CRC at all" apart from "has CRC but the group
// won't mint it" when the lift can't produce the stake token.
export async function getPersonalCrcBalance(player: string): Promise<bigint> {
  const id = BigInt(getAddress(player));
  return publicClient.readContract({
    address: HUB_ADDRESS,
    abi: hubAbi,
    functionName: "balanceOf",
    args: [player as `0x${string}`, id],
  });
}

// Convert a static (inflationary) stake into the demurraged amount groupMint/wrap
// expect at the current day. Both conversions floor, so the naive round-trip can
// land 1 wei short of the stake (verified on a fork). We bump the demurraged
// amount until wrapping it back yields >= `staticAmount`, so the minted s-gCRC
// always covers the stake; callers approve exactly `staticAmount` and keep the dust.
export async function staticToDemurrage(
  token: string,
  staticAmount: bigint,
): Promise<bigint> {
  const timestamp = BigInt(Math.floor(Date.now() / 1000));
  const day = await publicClient.readContract({
    address: HUB_ADDRESS,
    abi: hubAbi,
    functionName: "day",
    args: [timestamp],
  });
  let demurraged = await publicClient.readContract({
    address: token as `0x${string}`,
    abi: wrapperAbi,
    functionName: "convertInflationaryToDemurrageValue",
    args: [staticAmount, day],
  });
  // One read-back; bump by the static deficit (which is sub-static-wei, so a
  // single correction always closes the gap) until the wrap covers the stake.
  for (let i = 0; i < 4; i++) {
    const roundTrip = await publicClient.readContract({
      address: token as `0x${string}`,
      abi: wrapperAbi,
      functionName: "convertDemurrageToInflationaryValue",
      args: [demurraged, day],
    });
    if (roundTrip >= staticAmount) break;
    demurraged += staticAmount - roundTrip;
  }
  return demurraged;
}

export async function hasPlayerPlayed(
  player: string,
  gameId: number,
): Promise<boolean> {
  const [, , , , lastGameId] = await publicClient.readContract({
    address: STATS_CONTRACT,
    abi: statsAbi,
    functionName: "getStats",
    args: [player as `0x${string}`],
  });
  return lastGameId >= gameId;
}
