import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { membershipFor } from "./tree";
import { toHex32 } from "./poseidon";

/** The ordered ANSWERS list (parsed from the server module — public word set). */
function loadAnswers(): string[] {
  const src = readFileSync(join(import.meta.dir, "../words.server.ts"), "utf8");
  const words = src.match(/"([a-z]{5})"/g)?.map((q) => q.slice(1, -1)) ?? [];
  if (words.length !== 2315) throw new Error(`parsed ${words.length} answers`);
  return words;
}

describe("membershipFor", () => {
  const answers = loadAnswers();

  test("react recomputes the pinned DICT_ROOT", async () => {
    const { root, index } = await membershipFor(answers, "react");
    expect(index).toBe(1551);
    expect(toHex32(root)).toBe(
      "0x0984b03ac65fe9e4710ce7fb30f53d292b0d03f812b247ef32764d6018655f87",
    );
  });

  test("rejects a non-answer word", async () => {
    await expect(membershipFor(answers, "zzzzz")).rejects.toThrow();
  });
});
