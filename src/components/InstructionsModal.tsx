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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
      onClick={onClose}
    >
      <div
        className="bg-neutral-800 rounded-xl p-6 max-w-sm w-full mx-4 text-white max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-center text-lg font-bold mb-4 uppercase tracking-wider">
          How to Play
        </h2>

        <p className="text-sm text-neutral-300 mb-2">
          Guess the word in 6 tries.
        </p>
        <ul className="text-sm text-neutral-300 list-disc list-inside space-y-1 mb-5">
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
            <p className="text-sm text-neutral-300">
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
            <p className="text-sm text-neutral-300">
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
            <p className="text-sm text-neutral-300">
              <span className="font-bold uppercase">B</span> is not in the word
              in any spot.
            </p>
          </div>
        </div>

        <button
          onClick={onClose}
          className="mt-6 w-full py-2 rounded font-bold bg-green-600 hover:bg-green-700 transition-colors"
        >
          Got it
        </button>
      </div>
    </div>
  );
}
