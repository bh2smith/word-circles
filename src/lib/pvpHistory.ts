import type {
  PvpGameResponse,
  PvpTranscript,
  PvpTranscriptPlayer,
} from "@/lib/api";

export type HistoryOutcome = "ongoing" | "won" | "lost" | "draw";

const SETTLED = new Set(["settled", "completed"]);

export function isSettled(status: string): boolean {
  return SETTLED.has(status);
}

// Cumulative [greens, oranges] across all of a player's guesses — the
// equal-guess-count tiebreaker (mirrors backend settlement `tally_tiles`).
function tiles(p: PvpTranscriptPlayer): [number, number] {
  let greens = 0;
  let oranges = 0;
  for (const g of p.guesses) {
    for (const r of g.results) {
      if (r === "correct") greens++;
      else if (r === "present") oranges++;
    }
  }
  return [greens, oranges];
}

// Canonical head-to-head outcome, mirroring the backend `determine_winner`.
// Settlement only fires once every player has finished, so the finished/timeout
// branches never decide a settled game — it always reduces to: solving beats not
// solving, then fewest guesses, then cumulative tiles (greens then oranges); a
// genuine all-equal board is the only draw. Shared by the results screen and the
// history page so the two never disagree.
export function settledOutcome(
  me: PvpTranscriptPlayer,
  opp: PvpTranscriptPlayer,
): "won" | "lost" | "tie" {
  if (me.solved !== opp.solved) return me.solved ? "won" : "lost";
  if (me.solved && opp.solved) {
    if (me.guessCount < opp.guessCount) return "won";
    if (me.guessCount > opp.guessCount) return "lost";
  }
  const [mg, mo] = tiles(me);
  const [og, oo] = tiles(opp);
  if (mg !== og) return mg > og ? "won" : "lost";
  if (mo !== oo) return mo > oo ? "won" : "lost";
  return "tie";
}

// History badge derived from the authoritative transcript (solved + per-tile
// results), so an equal-guess-count game decided on tiles reads as Won/Lost
// rather than the Draw the guess-count-only list view falls back to. Returns
// null if the player isn't in the transcript.
export function transcriptOutcomeFor(
  transcript: PvpTranscript,
  player: string,
): HistoryOutcome | null {
  const me = transcript.players.find(
    (p) => p.address.toLowerCase() === player.toLowerCase(),
  );
  if (!me) return null;
  const opp = transcript.players.find((p) => p !== me);
  if (!opp) return me.solved ? "won" : "lost"; // solo settled game
  const result = settledOutcome(me, opp);
  return result === "tie" ? "draw" : result;
}

// Classify a game from the querying player's perspective. Win/loss is derived,
// not stored: for a settled game we apply the same rule the resolver uses
// (`determine_winner` in the backend) — finishing beats not finishing, and among
// finishers fewer guesses wins; an exact tie is a draw. Non-settled games are
// "ongoing".
export function outcomeFor(
  game: PvpGameResponse,
  player: string,
): HistoryOutcome {
  if (!isSettled(game.status)) return "ongoing";

  const me = game.players.find(
    (p) => p.address.toLowerCase() === player.toLowerCase(),
  );
  if (!me) return "lost"; // not a participant in a settled game — shouldn't happen

  const others = game.players.filter(
    (p) => p.address.toLowerCase() !== player.toLowerCase(),
  );
  // Solo settled game (opponent never joined and it was force-settled): treat a
  // finish as a win, otherwise a loss.
  if (others.length === 0) return me.status === "finished" ? "won" : "lost";

  const meFinished = me.status === "finished";
  const score = (p: { status: string; guessCount: number }) =>
    p.status === "finished" ? p.guessCount : Infinity;
  const myScore = score(me);
  const bestOther = Math.min(...others.map(score));

  if (myScore < bestOther) return "won";
  if (myScore > bestOther) return "lost";
  // Equal finishers (or both unfinished) — the pot was split.
  return meFinished ? "draw" : "lost";
}
