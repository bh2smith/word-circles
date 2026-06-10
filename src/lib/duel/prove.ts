/**
 * Generate the feedback proof a word-owner submits to WordleDuel.submitFeedback.
 * Runs entirely client-side (noir_js + bb.js WASM) — the trustless proving path.
 *
 * Heavy runtime module (WASM). Import it lazily from a client component:
 *   const { generateFeedbackProof } = await import("@/lib/duel/prove");
 */
import { Barretenberg, UltraHonkBackend } from "@aztec/bb.js";
import { Noir } from "@noir-lang/noir_js";
import circuit from "../../../circuits/artifacts/wordle_feedback.json";
import { wordToLetters } from "./encoding";
import { commitWord } from "./commitment";
import { membershipFor } from "./tree";
import { toHex32 } from "./poseidon";

export interface ProveParams {
  /** The owner's secret 5-letter word. */
  secret: string;
  /** Per-match random salt (field element). */
  salt: bigint;
  /** On-chain matchId as a bigint (see deriveMatchId). */
  matchBinding: bigint;
  /** The opponent's plaintext guess (5-letter string). */
  guess: string;
  /** The ordered public answer list the DICT_ROOT was pinned to. */
  answers: string[];
}

export interface ProveResult {
  /** UltraHonk proof bytes for submitFeedback. */
  proof: Uint8Array;
  /** The 9 public inputs (hex), in the order the verifier/contract expects. */
  publicInputs: string[];
  /** Packed base-4 feedback (682 = solved). */
  feedback: number;
}

/** Prove the Wordle feedback for `guess` against the committed `secret`. */
export async function generateFeedbackProof(
  params: ProveParams,
): Promise<ProveResult> {
  const { secret, salt, matchBinding, guess, answers } = params;

  const { index, siblings, root } = await membershipFor(answers, secret);
  const commitment = await commitWord(secret, salt, matchBinding);

  const inputs = {
    secret: wordToLetters(secret).map(String),
    salt: String(salt),
    leaf_index: String(index),
    merkle_path: siblings.map(toHex32),
    commitment,
    dictionary_root: toHex32(root),
    match_binding: toHex32(matchBinding),
    guess: wordToLetters(guess).map(String),
  };

  const noir = new Noir(circuit as ConstructorParameters<typeof Noir>[0]);
  const { witness, returnValue } = await noir.execute(inputs);

  const api = await Barretenberg.new({ threads: 1 });
  try {
    const backend = new UltraHonkBackend(
      (circuit as { bytecode: string }).bytecode,
      api,
    );
    const { proof, publicInputs } = await backend.generateProof(witness, {
      keccakZK: true,
    });
    return {
      proof,
      publicInputs,
      feedback: Number(BigInt(returnValue as string)),
    };
  } finally {
    await api.destroy();
  }
}
