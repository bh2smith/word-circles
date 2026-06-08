"use client";

import type { LetterResult } from "@/lib/game";

const ROWS = [
  ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
  ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
  ["Enter", "z", "x", "c", "v", "b", "n", "m", "⌫"],
];

const resultPriority: Record<LetterResult, number> = {
  correct: 3,
  present: 2,
  absent: 1,
};

const resultColors: Record<LetterResult, string> = {
  correct: "bg-correct text-state-foreground border-correct",
  present: "bg-present text-state-foreground border-present",
  absent: "bg-absent text-state-foreground border-absent",
};

interface KeyboardProps {
  letterStates: Map<string, LetterResult>;
  onKey: (key: string) => void;
  disabled?: boolean;
}

export default function Keyboard({
  letterStates,
  onKey,
  disabled,
}: KeyboardProps) {
  return (
    <div className="flex flex-col gap-1.5 items-center w-full max-w-lg mx-auto">
      {ROWS.map((row, i) => (
        <div key={i} className="flex gap-1 sm:gap-1.5 justify-center w-full">
          {row.map((key) => {
            const state = letterStates.get(key);
            const isWide = key === "Enter" || key === "⌫";
            const colorClass = state
              ? resultColors[state]
              : "bg-key-idle text-key-idle-foreground border-transparent hover:brightness-105";

            return (
              <button
                key={key}
                onClick={() => onKey(key)}
                disabled={disabled}
                className={`${colorClass} ${isWide ? "px-3 sm:px-4 text-xs sm:text-sm" : "w-8 sm:w-10 text-sm sm:text-base"} h-12 sm:h-14 rounded-lg font-semibold uppercase border transition-all select-none active:scale-95 active:brightness-90 disabled:opacity-50`}
              >
                {key}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

export function computeLetterStates(
  guesses: { word: string; results: LetterResult[] }[],
): Map<string, LetterResult> {
  const map = new Map<string, LetterResult>();
  for (const guess of guesses) {
    for (let i = 0; i < guess.word.length; i++) {
      const letter = guess.word[i];
      const result = guess.results[i];
      const existing = map.get(letter);
      if (!existing || resultPriority[result] > resultPriority[existing]) {
        map.set(letter, result);
      }
    }
  }
  return map;
}
