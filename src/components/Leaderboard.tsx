"use client";

import { useCallback, useEffect, useState } from "react";
import { CirclesProfile, fetchCirclesProfiles } from "@/lib/circles";

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

export function LeaderboardPanel({ gameId }: { gameId: number | null }) {
  const [tab, setTab] = useState<Tab>("daily");
  const [overall, setOverall] = useState<LeaderboardEntry[]>([]);
  const [daily, setDaily] = useState<DailyResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [profiles, setProfiles] = useState<Map<string, CirclesProfile>>(
    new Map(),
  );

  const loadProfiles = useCallback(async (addresses: string[]) => {
    if (addresses.length === 0) return;
    const map = await fetchCirclesProfiles(addresses);
    setProfiles((prev) => {
      const merged = new Map(prev);
      map.forEach((v, k) => merged.set(k, v));
      return merged;
    });
  }, []);

  const fetchOverall = useCallback(() => {
    setLoading(true);
    fetch("/api/leaderboard?limit=50")
      .then((r) => r.json())
      .then((entries: LeaderboardEntry[]) => {
        setOverall(entries);
        loadProfiles(entries.map((e) => e.address));
      })
      .catch(() => setOverall([]))
      .finally(() => setLoading(false));
  }, [loadProfiles]);

  const fetchDaily = useCallback(() => {
    if (gameId === null) return;
    setLoading(true);
    fetch(`/api/leaderboard/daily?gameId=${gameId}`)
      .then((r) => r.json())
      .then((results: DailyResult[]) => {
        setDaily(results);
        loadProfiles(results.map((r) => r.address));
      })
      .catch(() => setDaily([]))
      .finally(() => setLoading(false));
  }, [gameId, loadProfiles]);

  useEffect(() => {
    if (tab === "overall") fetchOverall();
    else fetchDaily();
  }, [tab, fetchOverall, fetchDaily]);

  return (
    <>
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
          <DailyTable results={daily} profiles={profiles} />
        ) : (
          <OverallTable entries={overall} profiles={profiles} />
        )}
      </div>
    </>
  );
}

export default function Leaderboard({
  open,
  onClose,
  gameId,
}: LeaderboardProps) {
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

        <LeaderboardPanel gameId={gameId} />

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

function PlayerCell({
  address,
  profiles,
}: {
  address: string;
  profiles: Map<string, CirclesProfile>;
}) {
  const profile = profiles.get(address.toLowerCase());
  return (
    <td className="py-1.5">
      <div className="flex items-center gap-2 min-w-0">
        {profile?.previewImageUrl ? (
          <img
            src={profile.previewImageUrl}
            alt=""
            className="w-5 h-5 rounded-full shrink-0"
          />
        ) : (
          <div className="w-5 h-5 rounded-full bg-neutral-600 shrink-0" />
        )}
        <span className="truncate text-sm">
          {profile?.name ?? truncateAddress(address)}
        </span>
      </div>
    </td>
  );
}

function OverallTable({
  entries,
  profiles,
}: {
  entries: LeaderboardEntry[];
  profiles: Map<string, CirclesProfile>;
}) {
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
            <PlayerCell address={entry.address} profiles={profiles} />
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

function DailyTable({
  results,
  profiles,
}: {
  results: DailyResult[];
  profiles: Map<string, CirclesProfile>;
}) {
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
            <PlayerCell address={result.address} profiles={profiles} />
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
