import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Barretenberg, UltraHonkBackend } from "@aztec/bb.js";
import circuit from "../../../circuits/artifacts/wordle_feedback.json";
import { generateFeedbackProof } from "./prove";

function loadAnswers(): string[] {
  const src = readFileSync(join(import.meta.dir, "../words.server.ts"), "utf8");
  return (src.match(/"([a-z]{5})"/g) ?? []).map((q) => q.slice(1, -1));
}

describe("generateFeedbackProof", () => {
  const answers = loadAnswers();

  test("proves crane vs react -> feedback 293, and the proof verifies", async () => {
    const { proof, publicInputs, feedback } = await generateFeedbackProof({
      secret: "react",
      salt: 123456789n,
      matchBinding: 0x1234567890abcdefn,
      guess: "crane",
      answers,
    });
    expect(feedback).toBe(293);
    expect(publicInputs).toHaveLength(9);

    const api = await Barretenberg.new({ threads: 1 });
    try {
      const backend = new UltraHonkBackend(
        (circuit as { bytecode: string }).bytecode,
        api,
      );
      const ok = await backend.verifyProof(
        { proof, publicInputs },
        { keccakZK: true },
      );
      expect(ok).toBe(true);
    } finally {
      await api.destroy();
    }
  }, 60_000);

  test("proves a solve (react vs react -> 682)", async () => {
    const { feedback } = await generateFeedbackProof({
      secret: "react",
      salt: 123456789n,
      matchBinding: 0x1234567890abcdefn,
      guess: "react",
      answers,
    });
    expect(feedback).toBe(682);
  }, 60_000);
});
