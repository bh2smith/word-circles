"use client";

import Board from "./Board";
import PlayerProfile from "./PlayerProfile";
import type { GuessResult, LetterResult } from "@/lib/game";
import type { PvpTranscript, PvpTranscriptPlayer } from "@/lib/api";

function toGuesses(p: PvpTranscriptPlayer): GuessResult[] {
  return p.guesses.map((g) => ({
    word: g.word,
    results: g.results as LetterResult[],
  }));
}

type Outcome = "won" | "lost" | "tie";

// Cumulative [greens, oranges] across all of a player's guesses — the
// equal-guess-count tiebreaker (see backend settlement `tally_tiles`).
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

// Mirrors the contract settlement priority: solving beats not solving, then
// fewest guesses wins; on an equal guess count, the closer board wins on
// cumulative greens then oranges, and only a true tile tie is a draw.
function outcome(me: PvpTranscriptPlayer, opp: PvpTranscriptPlayer): Outcome {
  if (me.solved !== opp.solved) return me.solved ? "won" : "lost";
  if (me.solved && opp.solved) {
    if (me.guessCount < opp.guessCount) return "won";
    if (me.guessCount > opp.guessCount) return "lost";
  }
  // Equal guess count (both solved in the same number, or both failed): break
  // the tie on cumulative tiles, greens first then oranges. (The backend instead
  // splits when *neither finished* — a timeout/abandon — but the transcript has
  // no finished flag to distinguish that here; solved games match exactly.)
  const [mg, mo] = tiles(me);
  const [og, oo] = tiles(opp);
  if (mg !== og) return mg > og ? "won" : "lost";
  if (mo !== oo) return mo > oo ? "won" : "lost";
  return "tie";
}

function PlayerColumn({
  player,
  title,
  highlight,
}: {
  player: PvpTranscriptPlayer;
  title: string;
  highlight: boolean;
}) {
  return (
    <div
      className={`flex flex-col items-center gap-2 rounded-xl p-3 ${
        highlight ? "ring-2 ring-green-500 bg-green-500/5" : "bg-neutral-800/40"
      }`}
    >
      <div className="flex flex-col items-center">
        <p className="font-semibold">{title}</p>
        <PlayerProfile
          address={player.address}
          className="text-neutral-300 text-xs"
        />
      </div>
      <Board guesses={toGuesses(player)} currentGuess="" shake={false} />
      <p className="text-sm text-neutral-400">
        {player.solved ? `Solved in ${player.guessCount}` : "Did not solve"}
      </p>
    </div>
  );
}

export default function PvpResults({
  transcript,
  myAddress,
  onPlayAgain,
}: {
  transcript: PvpTranscript;
  myAddress: string;
  onPlayAgain: () => void;
}) {
  const me =
    transcript.players.find(
      (p) => p.address.toLowerCase() === myAddress.toLowerCase(),
    ) ?? transcript.players[0];
  const opp = transcript.players.find((p) => p !== me) ?? null;

  const result = opp ? outcome(me, opp) : null;
  const heading =
    result === "won"
      ? "You won! 🏆"
      : result === "lost"
        ? "You lost"
        : result === "tie"
          ? "Draw"
          : "Results";

  return (
    <div className="flex flex-col items-center gap-5 text-white px-2 w-full max-w-2xl">
      <div className="text-center">
        <h2 className="text-2xl font-bold">{heading}</h2>
        <p className="text-neutral-400">
          The word was{" "}
          <span className="font-bold uppercase tracking-wider">
            {transcript.answer}
          </span>
        </p>
      </div>

      <div className="flex flex-col sm:flex-row gap-4 w-full justify-center">
        <PlayerColumn player={me} title="You" highlight={result === "won"} />
        {opp && (
          <PlayerColumn
            player={opp}
            title="Opponent"
            highlight={result === "lost"}
          />
        )}
      </div>

      <button
        onClick={onPlayAgain}
        className="px-6 py-2.5 rounded-lg bg-green-600 font-bold hover:bg-green-500 transition-colors"
      >
        Play Again
      </button>
    </div>
  );
}
