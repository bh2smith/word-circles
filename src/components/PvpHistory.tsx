"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  initCircles,
  subscribeWallet,
  getConnectedAddress,
} from "@/lib/circles";
import type { PvpGameResponse } from "@/lib/api";
import { outcomeFor, type HistoryOutcome } from "@/lib/pvpHistory";

type Tab = "ongoing" | "won" | "lost";

const TAB_LABELS: Record<Tab, string> = {
  ongoing: "Pending / Ongoing",
  won: "Won",
  lost: "Lost",
};

// A draw counts under "Won" for tab purposes (you didn't lose), but is badged
// distinctly in the row.
function tabFor(outcome: HistoryOutcome): Tab {
  if (outcome === "ongoing") return "ongoing";
  if (outcome === "lost") return "lost";
  return "won"; // won | draw
}

function truncate(addr: string): string {
  return addr.length <= 10 ? addr : `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function OutcomeBadge({ outcome }: { outcome: HistoryOutcome }) {
  const map: Record<HistoryOutcome, { label: string; cls: string }> = {
    ongoing: { label: "In progress", cls: "bg-yellow-500/15 text-yellow-400" },
    won: { label: "Won", cls: "bg-green-500/15 text-green-400" },
    lost: { label: "Lost", cls: "bg-red-500/15 text-red-400" },
    draw: { label: "Draw", cls: "bg-neutral-500/15 text-neutral-300" },
  };
  const { label, cls } = map[outcome];
  return (
    <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${cls}`}>
      {label}
    </span>
  );
}

function GameRow({
  game,
  outcome,
}: {
  game: PvpGameResponse;
  outcome: HistoryOutcome;
}) {
  // Ongoing games re-enter the live room; settled games open their result view.
  const href = `/pvp?game=${encodeURIComponent(game.gameId)}`;
  return (
    <Link
      href={href}
      className="flex items-center justify-between gap-3 rounded-lg bg-neutral-800/70 px-4 py-3 hover:bg-neutral-800 transition-colors"
    >
      <div className="flex flex-col gap-0.5 min-w-0">
        <span className="font-mono text-xs text-neutral-400 truncate">
          {truncate(game.gameId)}
        </span>
        <span className="text-xs text-neutral-500">
          {game.players.length}/{game.capacity} players
        </span>
      </div>
      <OutcomeBadge outcome={outcome} />
    </Link>
  );
}

export default function PvpHistory() {
  const [walletAddress, setWalletAddress] = useState<string | null>(
    getConnectedAddress(),
  );
  const [games, setGames] = useState<PvpGameResponse[] | null>(null);
  const [tab, setTab] = useState<Tab>("ongoing");

  useEffect(() => {
    initCircles();
    return subscribeWallet(setWalletAddress);
  }, []);

  const load = useCallback(async (address: string) => {
    const res = await fetch(`/api/games?player=${encodeURIComponent(address)}`);
    if (!res.ok) {
      setGames([]);
      return;
    }
    setGames(await res.json());
  }, []);

  useEffect(() => {
    if (walletAddress) load(walletAddress);
  }, [walletAddress, load]);

  if (!walletAddress) {
    return (
      <div className="text-center text-neutral-400 px-4">
        Connect your Circles wallet to see your match history.
      </div>
    );
  }

  if (games === null) {
    return <p className="text-neutral-400 animate-pulse">Loading history…</p>;
  }

  const classified = games.map((g) => ({
    game: g,
    outcome: outcomeFor(g, walletAddress),
  }));
  const visible = classified.filter(({ outcome }) => tabFor(outcome) === tab);

  return (
    <div className="flex flex-col gap-4 w-full max-w-lg mx-auto px-3 text-white">
      <h2 className="text-center text-lg font-bold">Match History</h2>

      <div className="flex justify-center gap-1.5">
        {(Object.keys(TAB_LABELS) as Tab[]).map((t) => {
          const count = classified.filter(
            ({ outcome }) => tabFor(outcome) === t,
          ).length;
          return (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-3 py-1.5 rounded text-sm font-semibold transition-colors ${
                tab === t
                  ? "bg-green-600 text-white"
                  : "bg-neutral-800 text-neutral-400 hover:text-white"
              }`}
            >
              {TAB_LABELS[t]}
              {count > 0 && (
                <span className="ml-1.5 text-xs opacity-70">{count}</span>
              )}
            </button>
          );
        })}
      </div>

      {visible.length === 0 ? (
        <p className="text-center text-neutral-500 text-sm py-8">
          No {TAB_LABELS[tab].toLowerCase()} games yet.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {visible.map(({ game, outcome }) => (
            <GameRow key={game.gameId} game={game} outcome={outcome} />
          ))}
        </div>
      )}
    </div>
  );
}
