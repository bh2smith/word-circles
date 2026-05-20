import { describe, expect, test } from "bun:test";
import { getGameId, isValidGuess } from "./game";
import { getAnswer, evaluateGuess } from "./game.server";

describe("getGameId", () => {
  test("returns 0 for epoch date", () => {
    expect(getGameId(new Date("2025-01-01T00:00:00Z"))).toBe(0);
  });

  test("increments daily", () => {
    const day1 = getGameId(new Date("2025-01-02T00:00:00Z"));
    const day2 = getGameId(new Date("2025-01-03T00:00:00Z"));
    expect(day1).toBe(1);
    expect(day2).toBe(2);
  });

  test("same day regardless of time", () => {
    const morning = getGameId(new Date("2025-06-15T06:00:00Z"));
    const evening = getGameId(new Date("2025-06-15T23:59:59Z"));
    expect(morning).toBe(evening);
  });
});

describe("getAnswer", () => {
  test("is deterministic", () => {
    expect(getAnswer(42)).toBe(getAnswer(42));
  });

  test("consecutive days produce different words", () => {
    const words = new Set([0, 1, 2, 3, 4].map(getAnswer));
    expect(words.size).toBe(5);
  });

  test("returns a 5-letter string", () => {
    const answer = getAnswer(100);
    expect(answer).toHaveLength(5);
    expect(answer).toMatch(/^[a-z]+$/);
  });

  test("is not alphabetically sequential", () => {
    const w0 = getAnswer(0);
    const w1 = getAnswer(1);
    const w2 = getAnswer(2);
    const sequential = w0 < w1 && w1 < w2;
    expect(sequential).toBe(false);
  });
});

describe("isValidGuess", () => {
  test("accepts valid 5-letter words", () => {
    expect(isValidGuess("crane")).toBe(true);
    expect(isValidGuess("about")).toBe(true);
  });

  test("rejects wrong length", () => {
    expect(isValidGuess("hi")).toBe(false);
    expect(isValidGuess("toolong")).toBe(false);
  });

  test("rejects non-words", () => {
    expect(isValidGuess("zzzzz")).toBe(false);
    expect(isValidGuess("xyzqw")).toBe(false);
  });
});

describe("evaluateGuess", () => {
  test("all correct", () => {
    expect(evaluateGuess("crane", "crane")).toEqual([
      "correct",
      "correct",
      "correct",
      "correct",
      "correct",
    ]);
  });

  test("all absent", () => {
    expect(evaluateGuess("think", "amble")).toEqual([
      "absent",
      "absent",
      "absent",
      "absent",
      "absent",
    ]);
  });

  test("mixed results", () => {
    // crane vs react: c=present, r=present, a=correct, n=absent, e=present
    expect(evaluateGuess("crane", "react")).toEqual([
      "present",
      "present",
      "correct",
      "absent",
      "present",
    ]);
  });

  test("duplicate letters — one correct, one absent", () => {
    expect(evaluateGuess("speed", "abide")).toEqual([
      "absent",
      "absent",
      "present",
      "absent",
      "present",
    ]);
  });

  test("duplicate guess letter with one match", () => {
    // geese vs edges: g=absent, e=present, e=present, s=present, e=absent (no more e's)
    expect(evaluateGuess("geese", "edges")).toEqual([
      "present",
      "present",
      "present",
      "present",
      "absent",
    ]);
  });

  test("is case insensitive", () => {
    expect(evaluateGuess("CRANE", "crane")).toEqual([
      "correct",
      "correct",
      "correct",
      "correct",
      "correct",
    ]);
  });
});
