import { describe, expect, test } from "bun:test";
import { outcomeFor, isSettled } from "./pvpHistory";
import type { PvpGameResponse } from "@/lib/api";

const ME = "0xaaaa000000000000000000000000000000000000";
const OPP = "0xbbbb000000000000000000000000000000000000";

function game(
  status: string,
  players: { address: string; status: string; guessCount: number }[],
): PvpGameResponse {
  return {
    gameId: "0x1",
    gameType: "pvp",
    status,
    capacity: 2,
    timeoutSecs: 10800,
    players,
  };
}

describe("outcomeFor", () => {
  test("non-settled is ongoing", () => {
    expect(
      outcomeFor(
        game("active", [{ address: ME, status: "playing", guessCount: 2 }]),
        ME,
      ),
    ).toBe("ongoing");
    expect(
      outcomeFor(
        game("open", [{ address: ME, status: "playing", guessCount: 0 }]),
        ME,
      ),
    ).toBe("ongoing");
  });

  test("fewer guesses wins", () => {
    const g = game("settled", [
      { address: ME, status: "finished", guessCount: 3 },
      { address: OPP, status: "finished", guessCount: 4 },
    ]);
    expect(outcomeFor(g, ME)).toBe("won");
    expect(outcomeFor(g, OPP)).toBe("lost");
  });

  test("finishing beats not finishing", () => {
    const g = game("settled", [
      { address: ME, status: "finished", guessCount: 6 },
      { address: OPP, status: "timed_out", guessCount: 2 },
    ]);
    expect(outcomeFor(g, ME)).toBe("won");
    expect(outcomeFor(g, OPP)).toBe("lost");
  });

  test("equal finishers is a draw", () => {
    const g = game("settled", [
      { address: ME, status: "finished", guessCount: 3 },
      { address: OPP, status: "finished", guessCount: 3 },
    ]);
    expect(outcomeFor(g, ME)).toBe("draw");
    expect(outcomeFor(g, OPP)).toBe("draw");
  });

  test("neither finished is a loss for both (pot split, no win)", () => {
    const g = game("settled", [
      { address: ME, status: "timed_out", guessCount: 1 },
      { address: OPP, status: "timed_out", guessCount: 1 },
    ]);
    expect(outcomeFor(g, ME)).toBe("lost");
  });

  test("solo settled: finished is a win", () => {
    expect(
      outcomeFor(
        game("settled", [{ address: ME, status: "finished", guessCount: 4 }]),
        ME,
      ),
    ).toBe("won");
    expect(
      outcomeFor(
        game("settled", [{ address: ME, status: "timed_out", guessCount: 0 }]),
        ME,
      ),
    ).toBe("lost");
  });

  test("case-insensitive address match", () => {
    const g = game("settled", [
      { address: ME.toUpperCase(), status: "finished", guessCount: 2 },
      { address: OPP, status: "finished", guessCount: 5 },
    ]);
    expect(outcomeFor(g, ME)).toBe("won");
  });
});

describe("isSettled", () => {
  test("settled/completed only", () => {
    expect(isSettled("settled")).toBe(true);
    expect(isSettled("completed")).toBe(true);
    expect(isSettled("active")).toBe(false);
    expect(isSettled("open")).toBe(false);
  });
});
