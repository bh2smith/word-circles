import { describe, expect, test } from "bun:test";
import {
  deriveMatchId,
  packFeedback,
  unpackFeedback,
  wordToLetters,
  lettersToWord,
  isSolved,
  FEEDBACK_SOLVED,
} from "./encoding";

describe("letters", () => {
  test("react -> indices", () => {
    expect(wordToLetters("react")).toEqual([17, 4, 0, 2, 19]);
  });
  test("round-trips", () => {
    expect(lettersToWord(wordToLetters("crane"))).toBe("crane");
  });
  test("rejects non-words", () => {
    expect(() => wordToLetters("hi")).toThrow();
    expect(() => wordToLetters("12345")).toThrow();
  });
});

describe("feedback packing", () => {
  test("all correct = 682", () => {
    expect(packFeedback([2, 2, 2, 2, 2])).toBe(FEEDBACK_SOLVED);
    expect(isSolved(682)).toBe(true);
  });
  test("crane vs react = 293", () => {
    // [present, present, correct, absent, present] = [1,1,2,0,1]
    expect(packFeedback([1, 1, 2, 0, 1])).toBe(293);
  });
  test("unpack round-trips", () => {
    expect(unpackFeedback(293)).toEqual([1, 1, 2, 0, 1]);
  });
});

describe("deriveMatchId", () => {
  test("matches the on-chain WordleDuel._matchId for (alice, 1)", () => {
    // Cross-check against the value computed in Solidity / the M3 fixture binding.
    const alice = "0x00000000000000000000000000000000000a11ce";
    expect(deriveMatchId(alice, 1n)).toBe(
      "0x0203dd68657862fa26bd7c4a12a3a2b3bbf2220be739d51860c5d12e036c38ec",
    );
  });
  test("is field-sized (< 2^253)", () => {
    const id = BigInt(
      deriveMatchId("0x00000000000000000000000000000000000a11ce", 7n),
    );
    expect(id < 1n << 253n).toBe(true);
  });
});
