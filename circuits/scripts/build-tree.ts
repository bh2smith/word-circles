/**
 * Builds the Poseidon2 Merkle tree over the 2315 Wordle ANSWERS and emits the
 * root + a membership path for a chosen word, ready to paste into Prover.toml.
 *
 *   bun run scripts/build-tree.ts            # default word: react
 *   bun run scripts/build-tree.ts crane
 *
 * Leaf encoding (must match main.nr): leaf = poseidon2([l0..l4]) with letters
 * a..z -> 0..25. Internal node = poseidon2([left, right]). The tree is padded
 * with zero leaves up to 2^DEPTH. DEPTH=12 (4096 >= 2315).
 *
 * The bb.js Poseidon2 is byte-identical to the Noir `poseidon` lib (verified
 * against the known commitment), so this tree is consistent with the circuit.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { initPoseidon, poseidon2n } from "./poseidon.ts";

export const DEPTH = 12; // 2^12 = 4096 >= 2315 answers

const here = dirname(fileURLToPath(import.meta.url));

/** Parse the ordered ANSWERS list out of src/lib/words.server.ts (server-only;
 *  can't be imported, so read it as text). Order defines the leaf index. */
export function loadAnswers(): string[] {
  const src = readFileSync(join(here, "../../src/lib/words.server.ts"), "utf8");
  // The file is just the ANSWERS array; every 5-letter quoted token is an answer.
  const words = src.match(/"([a-z]{5})"/g)?.map((q) => q.slice(1, -1)) ?? [];
  if (words.length !== 2315) {
    throw new Error(`expected 2315 answers, parsed ${words.length}`);
  }
  return words;
}

const letters = (w: string): bigint[] =>
  [...w].map((c) => BigInt(c.charCodeAt(0) - 97));

export const leafOf = (word: string): bigint => poseidon2n(letters(word));

/** Build all tree levels bottom-up. levels[0] = leaves, levels[DEPTH] = [root]. */
export function buildTree(leaves: bigint[]): bigint[][] {
  const size = 1 << DEPTH;
  const padded = leaves.slice();
  while (padded.length < size) padded.push(0n);
  const levels: bigint[][] = [padded];
  for (let d = 0; d < DEPTH; d++) {
    const cur = levels[d];
    const next: bigint[] = [];
    for (let i = 0; i < cur.length; i += 2) {
      next.push(poseidon2n([cur[i], cur[i + 1]]));
    }
    levels.push(next);
  }
  return levels;
}

/** Sibling path (length DEPTH) and index for the leaf at `index`. */
export function pathFor(
  levels: bigint[][],
  index: number,
): { siblings: bigint[]; index: number } {
  const siblings: bigint[] = [];
  let i = index;
  for (let d = 0; d < DEPTH; d++) {
    siblings.push(levels[d][i ^ 1]);
    i >>= 1;
  }
  return { siblings, index };
}

const hex = (n: bigint) => "0x" + n.toString(16).padStart(64, "0");

if (import.meta.main) {
  const word = (process.argv[2] ?? "react").toLowerCase();
  await initPoseidon();

  const answers = loadAnswers();
  const index = answers.indexOf(word);
  if (index < 0) throw new Error(`"${word}" is not in ANSWERS`);

  const levels = buildTree(answers.map(leafOf));
  const root = levels[DEPTH][0];
  const { siblings } = pathFor(levels, index);

  console.log(`word:            ${word}  (index ${index})`);
  console.log(`dictionary_root: ${hex(root)}`);
  console.log("--- Prover.toml ---");
  console.log(`dictionary_root = "${hex(root)}"`);
  console.log(`leaf_index = "${index}"`);
  console.log(`merkle_path = [`);
  console.log(siblings.map((s) => `  "${hex(s)}",`).join("\n"));
  console.log(`]`);
}
