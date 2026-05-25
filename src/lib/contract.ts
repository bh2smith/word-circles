import { encodeFunctionData, parseAbi } from "viem";

export const STATS_CONTRACT =
  "0xB96413584d7a4e07cc8c238cC4baA3474C956CCF" as const;

export const statsAbi = parseAbi([
  "function recordGame(uint32 gameId, bool won, uint8 guesses)",
  "function getStats(address player) view returns (uint32 gamesPlayed, uint32 gamesWon, uint32 currentStreak, uint32 maxStreak, uint32 lastGameId, uint32[6] guessDistribution)",
]);

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
