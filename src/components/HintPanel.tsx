"use client";

import { useMemo, useState } from "react";
import type { GuessResult } from "@/lib/game";
import { filterRemainingWords } from "@/lib/hints";

interface HintPanelProps {
  guesses: GuessResult[];
  onSelectWord: (word: string) => void;
  // When false, only the count of remaining words is shown — the expandable
  // list of clickable words (which lets you fill in a guess) is suppressed. The
  // daily game disables it so the count is informational but no hint is given.
  revealWords?: boolean;
}

export default function HintPanel({
  guesses,
  onSelectWord,
  revealWords = true,
}: HintPanelProps) {
  const [open, setOpen] = useState(false);
  const remaining = useMemo(() => filterRemainingWords(guesses), [guesses]);

  if (guesses.length === 0) return null;

  // Count only — show how many words remain but don't reveal which.
  if (!revealWords) {
    return (
      <span className="flex items-center gap-2 px-3 py-2 text-sm text-muted">
        {remaining.length.toLocaleString()} possible word
        {remaining.length !== 1 ? "s" : ""} left
      </span>
    );
  }

  return (
    <>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 px-3 py-2 text-sm text-muted hover:text-foreground transition-colors"
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
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute inset-x-0 top-0 bottom-0 z-50 flex items-center justify-center pointer-events-none px-2">
            <div className="pointer-events-auto w-full max-w-sm max-h-[70%] overflow-y-auto rounded-2xl bg-surface/95 border border-border shadow-2xl backdrop-blur-sm p-4">
              <div className="flex items-center justify-between mb-3 sticky top-0 bg-surface/95 pb-2">
                <span className="text-sm text-muted">
                  {remaining.length.toLocaleString()} possible word
                  {remaining.length !== 1 ? "s" : ""}
                </span>
                <button
                  onClick={() => setOpen(false)}
                  className="text-faint hover:text-foreground transition-colors p-1"
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M4 4l8 8M12 4l-8 8" />
                  </svg>
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {remaining.map((w) => (
                  <button
                    key={w}
                    onClick={() => {
                      onSelectWord(w);
                      setOpen(false);
                    }}
                    className="px-2 py-1 text-xs font-mono rounded-md bg-surface-2 text-muted hover:bg-primary-soft hover:text-foreground transition-colors"
                  >
                    {w}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}
