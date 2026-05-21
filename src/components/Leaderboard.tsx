"use client";

import { useCallback, useEffect, useState } from "react";

interface LeaderboardEntry {
  address: string;
  wins: number;
  games_played: number;
  avg_guesses: number;
}

interface DailyResult {
  address: string;
  guesses: number;
  solved: boolean;
}

function truncateAddress(addr: string): string {
  if (addr.length <= 10) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

type Tab = "overall" | "daily";

interface LeaderboardProps {
  open: boolean;
  onClose: () => void;
  gameId: number | null;
}

export default function Leaderboard({
  open,
  onClose,
  gameId,
}: LeaderboardProps) {
  const [tab, setTab] = useState<Tab>("daily");
  const [overall, setOverall] = useState<LeaderboardEntry[]>([]);
  const [daily, setDaily] = useState<DailyResult[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchOverall = useCallback(() => {
    setLoading(true);
    fetch("/api/leaderboard?limit=50")
      .then((r) => r.json())
      .then(setOverall)
      .catch(() => setOverall([]))
      .finally(() => setLoading(false));
  }, []);

  const fetchDaily = useCallback(() => {
    if (gameId === null) return;
    setLoading(true);
    fetch(`/api/leaderboard/daily?gameId=${gameId}`)
      .then((r) => r.json())
      .then(setDaily)
      .catch(() => setDaily([]))
      .finally(() => setLoading(false));
  }, [gameId]);

  useEffect(() => {
    if (!open) return;
    if (tab === "overall") fetchOverall();
    else fetchDaily();
  }, [open, tab, fetchOverall, fetchDaily]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
      onClick={onClose}
    >
      <div
        className="bg-neutral-800 rounded-xl p-6 max-w-md w-full mx-4 text-white max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-center text-lg font-bold mb-4 uppercase tracking-wider">
          Leaderboard
        </h2>

        <div className="flex gap-2 mb-4">
          <button
            onClick={() => setTab("daily")}
            className={`flex-1 py-1.5 rounded text-sm font-semibold transition-colors ${
              tab === "daily"
                ? "bg-green-600 text-white"
                : "bg-neutral-700 text-neutral-400 hover:text-white"
            }`}
          >
            Today #{gameId}
          </button>
          <button
            onClick={() => setTab("overall")}
            className={`flex-1 py-1.5 rounded text-sm font-semibold transition-colors ${
              tab === "overall"
                ? "bg-green-600 text-white"
                : "bg-neutral-700 text-neutral-400 hover:text-white"
            }`}
          >
            All Time
          </button>
        </div>

        <div className="flex-1 overflow-y-auto min-h-0">
          {loading ? (
            <p className="text-center text-neutral-400 py-8">Loading...</p>
          ) : tab === "daily" ? (
            <DailyTable results={daily} />
          ) : (
            <OverallTable entries={overall} />
          )}
        </div>

        <button
          onClick={onClose}
          className="mt-4 w-full py-2 bg-green-600 rounded font-bold hover:bg-green-700 transition-colors"
        >
          Close
        </button>
      </div>
    </div>
  );
}

function OverallTable({ entries }: { entries: LeaderboardEntry[] }) {
  if (entries.length === 0) {
    return (
      <p className="text-center text-neutral-400 py-8">No games played yet.</p>
    );
  }
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-neutral-400 text-xs uppercase tracking-wider">
          <th className="text-left py-1">#</th>
          <th className="text-left py-1">Player</th>
          <th className="text-right py-1">Wins</th>
          <th className="text-right py-1">Played</th>
          <th className="text-right py-1">Avg</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((entry, i) => (
          <tr key={entry.address} className="border-t border-neutral-700">
            <td className="py-1.5 text-neutral-400">{i + 1}</td>
            <td className="py-1.5 font-mono">
              {truncateAddress(entry.address)}
            </td>
            <td className="py-1.5 text-right">{entry.wins}</td>
            <td className="py-1.5 text-right">{entry.games_played}</td>
            <td className="py-1.5 text-right">
              {entry.avg_guesses > 0 ? entry.avg_guesses.toFixed(1) : "-"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DailyTable({ results }: { results: DailyResult[] }) {
  if (results.length === 0) {
    return (
      <p className="text-center text-neutral-400 py-8">
        No results for this game yet.
      </p>
    );
  }
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-neutral-400 text-xs uppercase tracking-wider">
          <th className="text-left py-1">#</th>
          <th className="text-left py-1">Player</th>
          <th className="text-right py-1">Guesses</th>
          <th className="text-right py-1">Result</th>
        </tr>
      </thead>
      <tbody>
        {results.map((result, i) => (
          <tr key={result.address} className="border-t border-neutral-700">
            <td className="py-1.5 text-neutral-400">{i + 1}</td>
            <td className="py-1.5 font-mono">
              {truncateAddress(result.address)}
            </td>
            <td className="py-1.5 text-right">{result.guesses}</td>
            <td className="py-1.5 text-right">
              {result.solved ? (
                <span className="text-green-400">Solved</span>
              ) : (
                <span className="text-neutral-500">Miss</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
