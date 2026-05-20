import { describe, expect, test } from "bun:test";
import { filterRemainingWords } from "./hints";
import type { GuessResult } from "./game";

describe("filterRemainingWords", () => {
  test("returns empty for no guesses", () => {
    expect(filterRemainingWords([])).toEqual([]);
  });

  test("filters out words with absent letters", () => {
    const guesses: GuessResult[] = [
      {
        word: "xyzqw",
        results: ["absent", "absent", "absent", "absent", "absent"],
      },
    ];
    const remaining = filterRemainingWords(guesses);
    for (const word of remaining) {
      expect(word).not.toContain("x");
      expect(word).not.toContain("y");
      expect(word).not.toContain("z");
      expect(word).not.toContain("q");
      expect(word).not.toContain("w");
    }
  });

  test("keeps words matching correct positions", () => {
    const guesses: GuessResult[] = [
      {
        word: "crane",
        results: ["correct", "absent", "absent", "absent", "absent"],
      },
    ];
    const remaining = filterRemainingWords(guesses);
    for (const word of remaining) {
      expect(word[0]).toBe("c");
    }
  });

  test("requires present letters but not in guessed position", () => {
    const guesses: GuessResult[] = [
      {
        word: "crane",
        results: ["absent", "present", "absent", "absent", "absent"],
      },
    ];
    const remaining = filterRemainingWords(guesses);
    for (const word of remaining) {
      expect(word).toContain("r");
      expect(word[1]).not.toBe("r");
    }
  });

  test("narrows down with multiple guesses", () => {
    const guesses: GuessResult[] = [
      {
        word: "crane",
        results: ["absent", "absent", "absent", "absent", "correct"],
      },
      {
        word: "spike",
        results: ["absent", "absent", "absent", "absent", "correct"],
      },
    ];
    const remaining = filterRemainingWords(guesses);
    for (const word of remaining) {
      expect(word[4]).toBe("e");
      expect(word).not.toContain("c");
      expect(word).not.toContain("r");
      expect(word).not.toContain("a");
      expect(word).not.toContain("n");
      expect(word).not.toContain("s");
      expect(word).not.toContain("p");
    }
  });

  test("returns sorted results", () => {
    const guesses: GuessResult[] = [
      {
        word: "crane",
        results: ["correct", "correct", "absent", "absent", "absent"],
      },
    ];
    const remaining = filterRemainingWords(guesses);
    for (let i = 1; i < remaining.length; i++) {
      expect(remaining[i] >= remaining[i - 1]).toBe(true);
    }
  });
});
