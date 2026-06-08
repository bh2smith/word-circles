"use client";

import Tile from "./Tile";

interface InstructionsModalProps {
  open: boolean;
  onClose: () => void;
}

export default function InstructionsModal({
  open,
  onClose,
}: InstructionsModalProps) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-surface border border-border shadow-xl rounded-2xl p-6 max-w-sm w-full mx-4 text-foreground max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-center text-lg font-bold mb-4 uppercase tracking-wide">
          How to Play
        </h2>

        <p className="text-sm text-muted mb-2">Guess the word in 6 tries.</p>
        <ul className="text-sm text-muted list-disc list-inside space-y-1 mb-5">
          <li>Each guess must be a valid 5-letter word.</li>
          <li>The colour of the tiles changes to show how close you are.</li>
        </ul>

        <h3 className="text-sm font-bold uppercase tracking-wider mb-3">
          Examples
        </h3>

        <div className="space-y-4">
          <div>
            <div className="flex gap-1 mb-1">
              <Tile letter="c" result="correct" />
              <Tile letter="r" />
              <Tile letter="a" />
              <Tile letter="n" />
              <Tile letter="e" />
            </div>
            <p className="text-sm text-muted">
              <span className="font-bold uppercase">C</span> is in the word and
              in the correct spot.
            </p>
          </div>

          <div>
            <div className="flex gap-1 mb-1">
              <Tile letter="m" />
              <Tile letter="o" result="present" />
              <Tile letter="u" />
              <Tile letter="s" />
              <Tile letter="e" />
            </div>
            <p className="text-sm text-muted">
              <span className="font-bold uppercase">O</span> is in the word but
              in the wrong spot.
            </p>
          </div>

          <div>
            <div className="flex gap-1 mb-1">
              <Tile letter="t" />
              <Tile letter="a" />
              <Tile letter="b" result="absent" />
              <Tile letter="l" />
              <Tile letter="e" />
            </div>
            <p className="text-sm text-muted">
              <span className="font-bold uppercase">B</span> is not in the word
              in any spot.
            </p>
          </div>
        </div>

        <button
          onClick={onClose}
          className="mt-6 w-full py-2.5 rounded-full font-bold bg-primary text-primary-foreground transition hover:opacity-90 active:scale-[0.98]"
        >
          Got it
        </button>
      </div>
    </div>
  );
}
