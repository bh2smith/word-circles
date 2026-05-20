"use client";

import { useMemo, useState } from "react";
import type { GuessResult } from "@/lib/game";
import { filterRemainingWords } from "@/lib/hints";

interface HintPanelProps {
  guesses: GuessResult[];
}

export default function HintPanel({ guesses }: HintPanelProps) {
  const [open, setOpen] = useState(false);
  const remaining = useMemo(() => filterRemainingWords(guesses), [guesses]);

  if (guesses.length === 0) return null;

  return (
    <div className="w-full max-w-lg">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 px-3 py-2 text-sm text-neutral-400 hover:text-white transition-colors"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className={`transition-transform ${open ? "rotate-90" : ""}`}
        >
          <path d="M6 4l4 4-4 4" />
        </svg>
        <span>
          {remaining.length.toLocaleString()} possible word
          {remaining.length !== 1 ? "s" : ""}
        </span>
      </button>
      {open && (
        <div className="mt-1 max-h-40 overflow-y-auto rounded bg-neutral-800 border border-neutral-700 px-3 py-2">
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-neutral-300 font-mono">
            {remaining.map((w) => (
              <span key={w}>{w}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
