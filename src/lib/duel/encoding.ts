/**
 * Pure encodings shared by the ZK duel client and the on-chain contracts.
 * No proving deps here — safe to import anywhere.
 *
 * Conventions (must stay in lock-step with circuits/wordle_feedback/src/main.nr
 * and contracts/zk/WordleDuel.sol):
 *   - letters a..z -> 0..25
 *   - tiles: absent=0, present=1, correct=2
 *   - feedback packed base-4, least-significant tile first: Σ tile_i · 4^i
 *   - matchId = keccak256(abi.encode(creator, nonce)) masked to 253 bits, so it
 *     is a valid bn254 field element usable as the circuit's match_binding.
 */
import {
  type Address,
  type Hex,
  encodeAbiParameters,
  keccak256,
  parseAbiParameters,
} from "viem";

export const WORD_LENGTH = 5;
export const MAX_GUESSES = 6;
/** Packed feedback meaning all five tiles correct: 2·(1+4+16+64+256). */
export const FEEDBACK_SOLVED = 682;

/** bn254 scalar field is ~2^254; mask to 253 bits to guarantee a field element. */
export const FIELD_MASK = (1n << 253n) - 1n;

export type Tile = 0 | 1 | 2; // absent | present | correct

/** "react" -> [17, 4, 0, 2, 19] */
export function wordToLetters(word: string): number[] {
  const w = word.toLowerCase();
  if (!/^[a-z]{5}$/.test(w)) throw new Error(`not a 5-letter word: ${word}`);
  return [...w].map((c) => c.charCodeAt(0) - 97);
}

export function lettersToWord(letters: readonly number[]): string {
  return letters.map((n) => String.fromCharCode(97 + n)).join("");
}

/** Unpack base-4 feedback into 5 tiles (LSB-first). */
export function unpackFeedback(packed: number): Tile[] {
  const tiles: Tile[] = [];
  for (let i = 0; i < WORD_LENGTH; i++) {
    tiles.push(((packed >> (2 * i)) & 3) as Tile);
  }
  return tiles;
}

/** Pack 5 tiles into base-4 feedback (LSB-first). */
export function packFeedback(tiles: readonly Tile[]): number {
  let packed = 0;
  for (let i = 0; i < WORD_LENGTH; i++) packed += tiles[i] * 4 ** i;
  return packed;
}

export function isSolved(packed: number): boolean {
  return packed === FEEDBACK_SOLVED;
}

/** Derive the on-chain matchId for (creator, nonce). Matches WordleDuel._matchId. */
export function deriveMatchId(creator: Address, nonce: bigint): Hex {
  const encoded = encodeAbiParameters(parseAbiParameters("address, uint256"), [
    creator,
    nonce,
  ]);
  const masked = BigInt(keccak256(encoded)) & FIELD_MASK;
  return `0x${masked.toString(16).padStart(64, "0")}`;
}
