import { encodeFunctionData } from "viem";

export const STATS_CONTRACT =
  "0xa4CBF2234A0a41C0F91CE43dfbEc2041e0A8D6D0" as const;

export const statsAbi = [
  {
    type: "function",
    name: "recordGame",
    inputs: [
      { name: "gameId", type: "uint32" },
      { name: "won", type: "bool" },
      { name: "guesses", type: "uint8" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "getStats",
    inputs: [{ name: "player", type: "address" }],
    outputs: [
      { name: "gamesPlayed", type: "uint32" },
      { name: "gamesWon", type: "uint32" },
      { name: "currentStreak", type: "uint32" },
      { name: "maxStreak", type: "uint32" },
      { name: "lastGameId", type: "uint32" },
      { name: "guessDistribution", type: "uint32[6]" },
    ],
    stateMutability: "view",
  },
] as const;

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
