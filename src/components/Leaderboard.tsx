"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  CirclesProfile,
  circlesProfileUrl,
  fetchCirclesProfiles,
  fetchTrustedAddresses,
  getConnectedAddress,
  isMiniappMode,
  subscribeWallet,
} from "@/lib/circles";
import type { LeaderboardEntry, DailyResult } from "@/lib/api";
import { api } from "@/lib/api/client";

function truncateAddress(addr: string): string {
  if (addr.length <= 10) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

// Shared pill-toggle styling for the Today/All-Time and Global/My-Circle rows.
function pillClass(active: boolean): string {
  return `flex-1 py-1.5 rounded-full text-sm font-semibold transition-colors ${
    active
      ? "bg-primary text-primary-foreground shadow-sm"
      : "bg-surface-2 text-muted hover:text-foreground"
  }`;
}

type Tab = "overall" | "daily";
type Scope = "global" | "circle";

interface LeaderboardProps {
  open: boolean;
  onClose: () => void;
  gameId: number | null;
}

export function LeaderboardPanel({ gameId }: { gameId: number | null }) {
  const [tab, setTab] = useState<Tab>("daily");
  const [scope, setScope] = useState<Scope>("global");
  const [overall, setOverall] = useState<LeaderboardEntry[]>([]);
  const [daily, setDaily] = useState<DailyResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [profiles, setProfiles] = useState<Map<string, CirclesProfile>>(
    new Map(),
  );
  const [wallet, setWallet] = useState<string | null>(getConnectedAddress());
  // Bumped on every load; a stale in-flight fetch checks this before committing
  // its result, so a slow "My Circle" request can't clobber a newer selection.
  const loadToken = useRef(0);

  useEffect(() => subscribeWallet(setWallet), []);

  // "My Circle" only means something when you have a connected wallet.
  // The toggle should always display (so users see it in standalone mode),
  // but "My Circle" is only effective when circleAvailable.
  const circleAvailable = wallet !== null && isMiniappMode();
  // A circle selection is only honored while it's available, so a wallet
  // disconnect transparently falls back to the global board without mutating
  // `scope` in an effect (and the selection reappears on reconnect).
  const effectiveScope: Scope = circleAvailable ? scope : "global";

  const loadProfiles = useCallback(
    async (addresses: string[], token: number) => {
      if (addresses.length === 0) return;
      const map = await fetchCirclesProfiles(addresses);
      if (token !== loadToken.current) return;
      setProfiles((prev) => {
        const merged = new Map(prev);
        map.forEach((v, k) => merged.set(k, v));
        return merged;
      });
    },
    [],
  );

  // The circle = the connected user plus everyone they trust.
  const circleAddresses = useCallback(async (): Promise<string[]> => {
    if (!wallet) return [];
    const trusted = await fetchTrustedAddresses(wallet);
    return [...new Set([wallet.toLowerCase(), ...trusted])];
  }, [wallet]);

  useEffect(() => {
    const token = ++loadToken.current;
    // Flip to the loading state synchronously before the async fetch starts.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);

    const run = async (): Promise<void> => {
      try {
        if (tab === "daily") {
          if (gameId === null) {
            setDaily([]);
            return;
          }
          let results: DailyResult[];
          if (effectiveScope === "circle") {
            const { data } = await api.POST("/api/leaderboard/daily/circle", {
              body: { gameId, addresses: await circleAddresses() },
            });
            results = data ?? [];
          } else {
            const { data } = await api.GET("/api/leaderboard/daily", {
              params: { query: { gameId } },
            });
            results = data ?? [];
          }
          if (token !== loadToken.current) return;
          setDaily(results);
          loadProfiles(
            results.map((r) => r.address),
            token,
          );
        } else {
          let entries: LeaderboardEntry[];
          if (effectiveScope === "circle") {
            const { data } = await api.POST("/api/leaderboard/circle", {
              body: { addresses: await circleAddresses(), limit: 50 },
            });
            entries = data ?? [];
          } else {
            const { data } = await api.GET("/api/leaderboard", {
              params: { query: { limit: 50 } },
            });
            entries = data ?? [];
          }
          if (token !== loadToken.current) return;
          setOverall(entries);
          loadProfiles(
            entries.map((e) => e.address),
            token,
          );
        }
      } catch {
        if (token !== loadToken.current) return;
        if (tab === "daily") setDaily([]);
        else setOverall([]);
      } finally {
        if (token === loadToken.current) setLoading(false);
      }
    };

    void run();
  }, [tab, effectiveScope, gameId, circleAddresses, loadProfiles]);

  const me = wallet?.toLowerCase() ?? null;

  return (
    <>
      <div className="flex gap-2 mb-4">
        <button
          onClick={() => setTab("daily")}
          className={pillClass(tab === "daily")}
        >
          Today #{gameId}
        </button>
        <button
          onClick={() => setTab("overall")}
          className={pillClass(tab === "overall")}
        >
          All Time
        </button>
      </div>

      {true && (
        <div className="flex gap-2 mb-4">
          <button
            onClick={() => setScope("global")}
            className={pillClass(scope === "global")}
          >
            Global
          </button>
          <button
            onClick={() => setScope("circle")}
            disabled={!circleAvailable}
            className={pillClass(scope === "circle") + (circleAvailable ? "" : " opacity-50 cursor-not-allowed")}
          >
            My Circle
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto min-h-0">
        {loading ? (
          <p className="text-center text-muted py-8">Loading...</p>
        ) : tab === "daily" ? (
          <DailyTable
            results={daily}
            profiles={profiles}
            me={me}
            scope={effectiveScope}
          />
        ) : (
          <OverallTable
            entries={overall}
            profiles={profiles}
            me={me}
            scope={effectiveScope}
          />
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-surface border border-border shadow-xl rounded-2xl p-6 max-w-md w-full mx-4 text-foreground max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-center text-lg font-bold mb-4 uppercase tracking-wide">
          Leaderboard
        </h2>

        <LeaderboardPanel gameId={gameId} />

        <button
          onClick={onClose}
          className="mt-4 w-full py-2.5 bg-primary text-primary-foreground rounded-full font-bold transition hover:opacity-90 active:scale-[0.98]"
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
      <a
        href={circlesProfileUrl(address)}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-2 min-w-0 hover:text-primary transition-colors"
      >
        {profile?.previewImageUrl ? (
          // Circles preview avatar from an arbitrary host/data URL; next/image
          // adds remotePatterns config + optimization cost with no benefit at
          // this size, so plain <img> is intentional.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={profile.previewImageUrl}
            alt=""
            className="w-5 h-5 rounded-full shrink-0"
          />
        ) : (
          <div className="w-5 h-5 rounded-full bg-surface-2 shrink-0" />
        )}
        <span className="truncate text-sm">
          {profile?.name ?? truncateAddress(address)}
        </span>
      </a>
    </td>
  );
}

function OverallTable({
  entries,
  profiles,
  me,
  scope,
}: {
  entries: LeaderboardEntry[];
  profiles: Map<string, CirclesProfile>;
  me: string | null;
  scope: Scope;
}) {
  if (entries.length === 0) {
    return (
      <p className="text-center text-muted py-8">
        {scope === "circle"
          ? "No one in your circle has played yet. Spread the word!"
          : "No games played yet."}
      </p>
    );
  }
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-muted text-xs uppercase tracking-wide">
          <th className="text-left py-1">#</th>
          <th className="text-left py-1">Player</th>
          <th className="text-right py-1">Wins</th>
          <th className="text-right py-1">Played</th>
          <th className="text-right py-1">Avg</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((entry, i) => (
          <tr
            key={entry.address}
            className={`border-t border-border${
              me && entry.address.toLowerCase() === me ? " bg-surface-2" : ""
            }`}
          >
            <td className="py-1.5 text-muted">{i + 1}</td>
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
  me,
  scope,
}: {
  results: DailyResult[];
  profiles: Map<string, CirclesProfile>;
  me: string | null;
  scope: Scope;
}) {
  if (results.length === 0) {
    return (
      <p className="text-center text-muted py-8">
        {scope === "circle"
          ? "No one in your circle has played this game yet."
          : "No results for this game yet."}
      </p>
    );
  }
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-muted text-xs uppercase tracking-wide">
          <th className="text-left py-1">#</th>
          <th className="text-left py-1">Player</th>
          <th className="text-right py-1">Guesses</th>
          <th className="text-right py-1">Result</th>
        </tr>
      </thead>
      <tbody>
        {results.map((result, i) => (
          <tr
            key={result.address}
            className={`border-t border-border${
              me && result.address.toLowerCase() === me ? " bg-surface-2" : ""
            }`}
          >
            <td className="py-1.5 text-muted">{i + 1}</td>
            <PlayerCell address={result.address} profiles={profiles} />
            <td className="py-1.5 text-right">{result.guesses}</td>
            <td className="py-1.5 text-right">
              {result.solved ? (
                <span className="font-semibold text-correct">Solved</span>
              ) : (
                <span className="text-faint">Miss</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
