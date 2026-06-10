/**
 * Word commitment for the duel: poseidon2([l0..l4, salt, match_binding]).
 * Bound to the match so a commitment (and the proofs that open it) can't be
 * reused in another match. Runtime module (uses bb.js via ./poseidon).
 */
import type { Hex } from "viem";
import { wordToLetters } from "./encoding";
import { poseidon2, toHex32 } from "./poseidon";

/**
 * @param secret      the 5-letter answer word
 * @param salt        per-match random field element
 * @param matchBinding the on-chain matchId as a bigint (see deriveMatchId)
 */
export async function commitWord(
  secret: string,
  salt: bigint,
  matchBinding: bigint,
): Promise<Hex> {
  const letters = wordToLetters(secret).map(BigInt);
  return toHex32(await poseidon2([...letters, salt, matchBinding]));
}
