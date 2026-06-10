/**
 * viem ABI + call encoders for WordleDuel. Pure (viem only).
 * Mirrors the external surface of contracts/zk/WordleDuel.sol.
 */
import { type Address, type Hex, bytesToHex, encodeFunctionData } from "viem";
import { WORD_LENGTH, wordToLetters } from "./encoding";

export type GuessTuple = readonly [number, number, number, number, number];

export interface FeedbackProofLike {
  feedback: number;
  proof?: Uint8Array;
  proofHex?: Hex;
}

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
  {
    type: "function",
    name: "token",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "DICT_ROOT",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "getMatch",
    stateMutability: "view",
    inputs: [{ name: "matchId", type: "bytes32" }],
    outputs: [
      { name: "playerA", type: "address" },
      { name: "playerB", type: "address" },
      { name: "stake", type: "uint256" },
      { name: "commitmentA", type: "bytes32" },
      { name: "commitmentB", type: "bytes32" },
      { name: "createDeadline", type: "uint64" },
      { name: "status", type: "uint8" },
    ],
  },
  {
    type: "function",
    name: "getTrack",
    stateMutability: "view",
    inputs: [
      { name: "matchId", type: "bytes32" },
      { name: "isTrackA", type: "bool" },
    ],
    outputs: [
      { name: "guessCount", type: "uint8" },
      { name: "greens", type: "uint8" },
      { name: "oranges", type: "uint8" },
      { name: "solvedAtGuess", type: "uint8" },
      { name: "solved", type: "bool" },
      { name: "pendingGuess", type: "bool" },
      { name: "deadline", type: "uint64" },
      { name: "guess", type: "uint8[5]" },
    ],
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
  guess: string | readonly number[],
): Hex =>
  encodeFunctionData({
    abi: WORDLE_DUEL_ABI,
    functionName: "submitGuess",
    args: [matchId, normalizeGuess(guess)],
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

export const encodeSubmitFeedbackFromProof = (
  matchId: Hex,
  result: FeedbackProofLike,
): Hex => {
  const proof =
    result.proofHex ?? (result.proof ? bytesToHex(result.proof) : undefined);
  if (!proof) throw new Error("proof result is missing proof/proofHex");
  return encodeSubmitFeedback(matchId, result.feedback, proof);
};

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

function normalizeGuess(guess: string | readonly number[]): GuessTuple {
  const letters = typeof guess === "string" ? wordToLetters(guess) : [...guess];
  if (letters.length !== WORD_LENGTH) {
    throw new Error(`guess must contain exactly ${WORD_LENGTH} letters`);
  }
  for (const letter of letters) {
    if (!Number.isInteger(letter) || letter < 0 || letter >= 26) {
      throw new Error(`invalid guess letter: ${letter}`);
    }
  }
  return letters as unknown as GuessTuple;
}

export type { Address };
