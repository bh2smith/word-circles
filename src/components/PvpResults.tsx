"use client";

import Board from "./Board";
import PlayerProfile from "./PlayerProfile";
import type { GuessResult, LetterResult } from "@/lib/game";
import type { PvpTranscript, PvpTranscriptPlayer } from "@/lib/api";
import { settledOutcome } from "@/lib/pvpHistory";

function toGuesses(p: PvpTranscriptPlayer): GuessResult[] {
  return p.guesses.map((g) => ({
    word: g.word,
    results: g.results as LetterResult[],
  }));
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
      className={`flex flex-col items-center gap-2 rounded-2xl border p-3 ${
        highlight
          ? "border-correct ring-2 ring-correct/60 bg-correct/10"
          : "border-border bg-surface-2/60"
      }`}
    >
      <div className="flex flex-col items-center">
        <p className="font-semibold">{title}</p>
        <PlayerProfile
          address={player.address}
          className="text-muted text-xs"
        />
      </div>
      <Board guesses={toGuesses(player)} currentGuess="" shake={false} />
      <p className="text-sm text-muted">
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

  const result = opp ? settledOutcome(me, opp) : null;
  const heading =
    result === "won"
      ? "You won! 🏆"
      : result === "lost"
        ? "You lost"
        : result === "tie"
          ? "Draw"
          : "Results";

  return (
    <div className="flex flex-col items-center gap-5 px-2 w-full max-w-2xl">
      <div className="text-center">
        <h2 className="text-2xl font-extrabold">{heading}</h2>
        <p className="text-muted">
          The word was{" "}
          <span className="font-bold uppercase tracking-wide text-secondary">
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
        className="px-6 py-2.5 rounded-full bg-primary text-primary-foreground font-bold shadow-sm transition hover:opacity-90 active:scale-95"
      >
        Play Again
      </button>
    </div>
  );
}
