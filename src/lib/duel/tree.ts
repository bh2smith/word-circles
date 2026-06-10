/**
 * Poseidon Merkle tree over the ANSWERS dictionary, matching the circuit's
 * membership check (leaf = poseidon2([l0..l4]); node = poseidon2([left,right]);
 * depth 12, zero-padded). Runtime module (uses bb.js via ./poseidon).
 *
 * The caller supplies the ordered `answers` list (the public Wordle answer set,
 * e.g. fetched from the pinned IPFS copy). The ordering defines leaf indices and
 * must be the exact list the on-chain DICT_ROOT was pinned to.
 */
import { wordToLetters } from "./encoding";
import { poseidon2 } from "./poseidon";

export const DEPTH = 12; // 2^12 = 4096 >= 2315 answers

export async function leafOf(word: string): Promise<bigint> {
  return poseidon2(wordToLetters(word).map(BigInt));
}

/** Build all tree levels bottom-up. levels[0] = leaves, levels[DEPTH] = [root]. */
export async function buildTree(answers: string[]): Promise<bigint[][]> {
  const size = 1 << DEPTH;
  const leaves: bigint[] = [];
  for (const w of answers) leaves.push(await leafOf(w));
  while (leaves.length < size) leaves.push(0n);

  const levels: bigint[][] = [leaves];
  for (let d = 0; d < DEPTH; d++) {
    const cur = levels[d];
    const next: bigint[] = [];
    for (let i = 0; i < cur.length; i += 2) {
      next.push(await poseidon2([cur[i], cur[i + 1]]));
    }
    levels.push(next);
  }
  return levels;
}

export function rootOf(levels: bigint[][]): bigint {
  return levels[DEPTH][0];
}

/** Sibling path (length DEPTH) for the leaf at `index`. */
export function pathFor(levels: bigint[][], index: number): bigint[] {
  const siblings: bigint[] = [];
  let i = index;
  for (let d = 0; d < DEPTH; d++) {
    siblings.push(levels[d][i ^ 1]);
    i >>= 1;
  }
  return siblings;
}

export interface Membership {
  root: bigint;
  index: number;
  siblings: bigint[];
}

/** Build the tree and extract the membership proof for `word`. */
export async function membershipFor(
  answers: string[],
  word: string,
): Promise<Membership> {
  const index = answers.indexOf(word.toLowerCase());
  if (index < 0) throw new Error(`"${word}" is not in the answer list`);
  const levels = await buildTree(answers);
  return { root: rootOf(levels), index, siblings: pathFor(levels, index) };
}
