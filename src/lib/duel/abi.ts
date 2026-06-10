/**
 * viem ABI + call encoders for WordleDuel. Pure (viem only).
 * Mirrors the external surface of contracts/zk/WordleDuel.sol.
 */
import { type Address, type Hex, encodeFunctionData } from "viem";

export const WORDLE_DUEL_ABI = [
  {
    type: "function",
    name: "createMatch",
    stateMutability: "nonpayable",
    inputs: [
      { name: "nonce", type: "uint256" },
      { name: "commitmentA", type: "bytes32" },
      { name: "stake", type: "uint256" },
    ],
    outputs: [{ name: "matchId", type: "bytes32" }],
  },
  {
    type: "function",
    name: "joinMatch",
    stateMutability: "nonpayable",
    inputs: [
      { name: "matchId", type: "bytes32" },
      { name: "commitmentB", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "cancelMatch",
    stateMutability: "nonpayable",
    inputs: [{ name: "matchId", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "submitGuess",
    stateMutability: "nonpayable",
    inputs: [
      { name: "matchId", type: "bytes32" },
      { name: "guess", type: "uint8[5]" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "submitFeedback",
    stateMutability: "nonpayable",
    inputs: [
      { name: "matchId", type: "bytes32" },
      { name: "feedback", type: "uint16" },
      { name: "proof", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "settle",
    stateMutability: "nonpayable",
    inputs: [{ name: "matchId", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  {
    type: "function",
    name: "withdrawable",
    stateMutability: "view",
    inputs: [{ name: "player", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export const encodeCreateMatch = (
  nonce: bigint,
  commitmentA: Hex,
  stake: bigint,
): Hex =>
  encodeFunctionData({
    abi: WORDLE_DUEL_ABI,
    functionName: "createMatch",
    args: [nonce, commitmentA, stake],
  });

export const encodeJoinMatch = (matchId: Hex, commitmentB: Hex): Hex =>
  encodeFunctionData({
    abi: WORDLE_DUEL_ABI,
    functionName: "joinMatch",
    args: [matchId, commitmentB],
  });

export const encodeSubmitGuess = (
  matchId: Hex,
  guess: readonly number[],
): Hex =>
  encodeFunctionData({
    abi: WORDLE_DUEL_ABI,
    functionName: "submitGuess",
    args: [
      matchId,
      guess as unknown as readonly [number, number, number, number, number],
    ],
  });

export const encodeSubmitFeedback = (
  matchId: Hex,
  feedback: number,
  proof: Hex,
): Hex =>
  encodeFunctionData({
    abi: WORDLE_DUEL_ABI,
    functionName: "submitFeedback",
    args: [matchId, feedback, proof],
  });

export const encodeSettle = (matchId: Hex): Hex =>
  encodeFunctionData({
    abi: WORDLE_DUEL_ABI,
    functionName: "settle",
    args: [matchId],
  });

export const encodeWithdraw = (): Hex =>
  encodeFunctionData({
    abi: WORDLE_DUEL_ABI,
    functionName: "withdraw",
    args: [],
  });

export const encodeCancelMatch = (matchId: Hex): Hex =>
  encodeFunctionData({
    abi: WORDLE_DUEL_ABI,
    functionName: "cancelMatch",
    args: [matchId],
  });

export type { Address };
