"use client";

import PlayerProfile from "./PlayerProfile";
import type { PvpPlayerStatus } from "@/lib/api";

const PlayingDots = () => (
  <span className="inline-flex gap-0.5">
    <span className="w-1.5 h-1.5 bg-yellow-400 rounded-full animate-bounce [animation-delay:-0.3s]" />
    <span className="w-1.5 h-1.5 bg-yellow-400 rounded-full animate-bounce [animation-delay:-0.15s]" />
    <span className="w-1.5 h-1.5 bg-yellow-400 rounded-full animate-bounce" />
  </span>
);

const CheckIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    aria-hidden="true"
  >
    <path
      d="M5 13l4 4L19 7"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const ClockIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
    <path
      d="M12 7v5l3 2"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

// Opponent state during PvP, with no gameplay spoilers: the guess count is
// withheld until the game has settled.
export default function OpponentStatus({
  opponent,
  settled,
}: {
  opponent: PvpPlayerStatus | null;
  settled: boolean;
}) {
  if (!opponent) {
    return (
      <div className="flex items-center gap-2 text-sm text-neutral-400 bg-neutral-800 rounded-full px-3 py-1.5">
        <span>Waiting for opponent…</span>
      </div>
    );
  }

  let icon: React.ReactNode;
  let label: string;
  let tone: string;
  switch (opponent.status) {
    case "finished":
      icon = <CheckIcon />;
      label = "Opponent finished";
      tone = "text-green-400";
      break;
    case "timed_out":
      icon = <ClockIcon />;
      label = "Opponent timed out";
      tone = "text-orange-400";
      break;
    case "playing":
      icon = <PlayingDots />;
      label = "Opponent is playing";
      tone = "text-yellow-400";
      break;
    default:
      icon = null;
      label = "Opponent hasn't started";
      tone = "text-neutral-400";
  }

  return (
    <div className="flex items-center gap-2 text-sm bg-neutral-800 rounded-full px-3 py-1.5">
      <PlayerProfile
        address={opponent.address}
        className="text-neutral-300 text-xs"
      />
      <span className={`flex items-center gap-1.5 ${tone}`}>
        {icon}
        {label}
      </span>
      {settled && (
        <span className="text-neutral-400">
          · {opponent.guessCount} guesses
        </span>
      )}
    </div>
  );
}
