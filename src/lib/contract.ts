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
