import { createPublicClient, encodeFunctionData, http, parseAbi } from "viem";
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
]);

export const escrowAbi = parseAbi([
  "function join(address resolver, address token, uint256 amount, uint128 capacity) returns (bytes32)",
]);

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
