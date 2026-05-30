import type { PvpGameResponse } from "@/lib/api";

export type HistoryOutcome = "ongoing" | "won" | "lost" | "draw";

const SETTLED = new Set(["settled", "completed"]);

export function isSettled(status: string): boolean {
  return SETTLED.has(status);
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
