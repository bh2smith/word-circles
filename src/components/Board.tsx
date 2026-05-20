"use client";

import Tile from "./Tile";
import type { GuessResult } from "@/lib/game";
import { WORD_LENGTH, MAX_GUESSES } from "@/lib/game";

interface BoardProps {
  guesses: GuessResult[];
  currentGuess: string;
  shake: boolean;
}

export default function Board({ guesses, currentGuess, shake }: BoardProps) {
  const rows: React.ReactNode[] = [];

  for (let i = 0; i < MAX_GUESSES; i++) {
    const isCurrentRow = i === guesses.length;
    const guess = guesses[i];

    const tiles: React.ReactNode[] = [];
    for (let j = 0; j < WORD_LENGTH; j++) {
      if (guess) {
        tiles.push(
          <Tile key={j} letter={guess.word[j]} result={guess.results[j]} />,
        );
      } else if (isCurrentRow) {
        tiles.push(
          <Tile key={j} letter={currentGuess[j] || ""} isCurrent={true} />,
        );
      } else {
        tiles.push(<Tile key={j} letter="" />);
      }
    }

    rows.push(
      <div
        key={i}
        className={`flex gap-1.5 ${isCurrentRow && shake ? "animate-shake" : ""}`}
      >
        {tiles}
      </div>,
    );
  }

  return <div className="flex flex-col gap-1.5 items-center">{rows}</div>;
}
