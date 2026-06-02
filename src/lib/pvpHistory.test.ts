import { describe, expect, test } from "bun:test";
import {
  outcomeFor,
  isSettled,
  settledOutcome,
  transcriptOutcomeFor,
} from "./pvpHistory";
import type {
  PvpGameResponse,
  PvpTranscript,
  PvpTranscriptPlayer,
} from "@/lib/api";

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

// Build a transcript player from compact per-guess tile strings (g/o/_ ->
// correct/present/absent). The last row's solved flag is derived from `solved`.
function tplayer(
  address: string,
  solved: boolean,
  rows: string[],
): PvpTranscriptPlayer {
  const map: Record<string, "correct" | "present" | "absent"> = {
    g: "correct",
    o: "present",
    _: "absent",
  };
  return {
    address,
    solved,
    guessCount: rows.length,
    guesses: rows.map((row) => ({
      word: "crane",
      results: [...row].map((c) => map[c]),
    })),
  };
}

function transcript(...players: PvpTranscriptPlayer[]): PvpTranscript {
  return { gameId: "0x1", status: "settled", answer: "crane", players };
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

describe("settledOutcome (transcript: solved -> guesses -> tiles)", () => {
  test("solving beats not solving", () => {
    const me = tplayer(ME, true, ["___oo", "ggggg"]);
    const opp = tplayer(OPP, false, ["___oo", "g__o_", "_____"]);
    expect(settledOutcome(me, opp)).toBe("won");
    expect(settledOutcome(opp, me)).toBe("lost");
  });

  test("both solved: fewer guesses wins", () => {
    const me = tplayer(ME, true, ["g_o__", "ggggg"]);
    const opp = tplayer(OPP, true, ["__o__", "g_o__", "ggggg"]);
    expect(settledOutcome(me, opp)).toBe("won");
    expect(settledOutcome(opp, me)).toBe("lost");
  });

  test("equal guess count broken by greens (the draw bug)", () => {
    // Both solved in 2; same guess count. Pre-fix this read as a draw — now the
    // richer first row (more greens) wins it.
    const me = tplayer(ME, true, ["ggg__", "ggggg"]);
    const opp = tplayer(OPP, true, ["g____", "ggggg"]);
    expect(settledOutcome(me, opp)).toBe("won");
    expect(settledOutcome(opp, me)).toBe("lost");
  });

  test("equal greens broken by oranges", () => {
    const me = tplayer(ME, true, ["g_ooo", "ggggg"]);
    const opp = tplayer(OPP, true, ["g_o__", "ggggg"]);
    expect(settledOutcome(me, opp)).toBe("won");
  });

  test("genuinely identical boards are a tie", () => {
    const me = tplayer(ME, true, ["g_o__", "ggggg"]);
    const opp = tplayer(OPP, true, ["g_o__", "ggggg"]);
    expect(settledOutcome(me, opp)).toBe("tie");
  });

  test("neither solved: closer board wins on tiles", () => {
    const me = tplayer(ME, false, ["gg___", "gg_o_", "gg_o_"]);
    const opp = tplayer(OPP, false, ["g____", "g__o_", "g____"]);
    expect(settledOutcome(me, opp)).toBe("won");
  });
});

describe("transcriptOutcomeFor", () => {
  test("tile-tiebreak win reads as Won, not Draw", () => {
    const t = transcript(
      tplayer(ME, true, ["ggg__", "ggggg"]),
      tplayer(OPP, true, ["g____", "ggggg"]),
    );
    expect(transcriptOutcomeFor(t, ME)).toBe("won");
    expect(transcriptOutcomeFor(t, OPP)).toBe("lost");
  });

  test("true tie reads as Draw", () => {
    const t = transcript(
      tplayer(ME, true, ["g_o__", "ggggg"]),
      tplayer(OPP, true, ["g_o__", "ggggg"]),
    );
    expect(transcriptOutcomeFor(t, ME)).toBe("draw");
  });

  test("solo settled game: solved is a win", () => {
    const t = transcript(tplayer(ME, true, ["ggggg"]));
    expect(transcriptOutcomeFor(t, ME)).toBe("won");
  });

  test("non-participant returns null", () => {
    const t = transcript(
      tplayer(ME, true, ["ggggg"]),
      tplayer(OPP, false, ["_____"]),
    );
    expect(transcriptOutcomeFor(t, "0xcccc")).toBeNull();
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
