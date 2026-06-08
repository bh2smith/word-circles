"use client";

import type { LetterResult } from "@/lib/game";

const colorMap: Record<LetterResult, string> = {
  correct: "bg-correct border-correct text-state-foreground",
  present: "bg-present border-present text-state-foreground",
  absent: "bg-absent border-absent text-state-foreground",
};

interface TileProps {
  letter: string;
  result?: LetterResult;
  isCurrent?: boolean;
}

export default function Tile({ letter, result, isCurrent }: TileProps) {
  const base =
    "w-14 h-14 sm:w-16 sm:h-16 rounded-xl border-2 flex items-center justify-center text-2xl sm:text-3xl font-bold uppercase transition-all duration-200 select-none";

  let style: string;
  if (result) {
    // Resolved tile: brand state color with a brief pop on reveal.
    style = `${colorMap[result]} shadow-sm animate-pop-in`;
  } else if (letter) {
    style = "border-tile-filled text-foreground bg-surface scale-105";
  } else {
    style = "border-tile-empty text-foreground bg-surface/40";
  }

  return (
    <div
      className={`${base} ${style} ${isCurrent && letter ? "scale-105" : ""}`}
    >
      {letter}
    </div>
  );
}
