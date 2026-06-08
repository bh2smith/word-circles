"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  initCircles,
  subscribeWallet,
  getConnectedAddress,
} from "@/lib/circles";
import type { PvpGameResponse } from "@/lib/api";
import { api } from "@/lib/api/client";
import {
  outcomeFor,
  isSettled,
  transcriptOutcomeFor,
  type HistoryOutcome,
} from "@/lib/pvpHistory";
import { usePvpEnabled } from "@/lib/usePvpEnabled";

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
    ongoing: { label: "In progress", cls: "bg-present/15 text-present" },
    won: { label: "Won", cls: "bg-correct/15 text-correct" },
    lost: { label: "Lost", cls: "bg-secondary/15 text-secondary" },
    draw: { label: "Draw", cls: "bg-surface-2 text-muted" },
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
      className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface px-4 py-3 shadow-sm transition-colors hover:bg-primary-soft"
    >
      <div className="flex flex-col gap-0.5 min-w-0">
        <span className="font-mono text-xs text-muted truncate">
          {truncate(game.gameId)}
        </span>
        <span className="text-xs text-faint">
          {game.players.length}/{game.capacity} players
        </span>
      </div>
      <OutcomeBadge outcome={outcome} />
    </Link>
  );
}

export default function PvpHistory() {
  // Same both-sides gate as the nav and the /pvp page: only render history when
  // the frontend opted in AND the backend reports PvP live. A direct visit to
  // /pvp/history (the nav link is hidden) otherwise still exposed the feature.
  const pvpEnabled = usePvpEnabled();
  const [walletAddress, setWalletAddress] = useState<string | null>(
    getConnectedAddress(),
  );
  const [games, setGames] = useState<PvpGameResponse[] | null>(null);
  // Authoritative per-game outcomes derived from each settled game's transcript
  // (solved + tiles), keyed by gameId. The guess-count-only list response can't
  // break an equal-guess-count tie, so it mislabels tile-decided wins as draws;
  // this overrides those once the transcripts load.
  const [resolved, setResolved] = useState<Record<string, HistoryOutcome>>({});
  const [tab, setTab] = useState<Tab>("ongoing");

  useEffect(() => {
    initCircles();
    return subscribeWallet(setWalletAddress);
  }, []);

  const load = useCallback(async (address: string) => {
    const { data } = await api.GET("/api/games", {
      params: { query: { player: address } },
    });
    setGames(data ?? []);
  }, []);

  useEffect(() => {
    // load() only setstates after an await, so this is not a synchronous
    // cascading render; the rule flags the indirect setter call.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (walletAddress) load(walletAddress);
  }, [walletAddress, load]);

  // Refine settled games with the transcript-derived outcome so a tile-tiebreak
  // win shows as Won rather than the list view's guess-count-only Draw fallback.
  useEffect(() => {
    if (!games || !walletAddress) return;
    let active = true;
    const settled = games.filter((g) => isSettled(g.status));
    Promise.all(
      settled.map(async (g) => {
        try {
          const { data: t } = await api.GET("/api/games/{game_id}/transcript", {
            params: { path: { game_id: g.gameId } },
          });
          if (!t) return null;
          const outcome = transcriptOutcomeFor(t, walletAddress);
          return outcome ? ([g.gameId, outcome] as const) : null;
        } catch {
          return null;
        }
      }),
    ).then((entries) => {
      if (!active) return;
      const next = Object.fromEntries(
        entries.filter((e): e is readonly [string, HistoryOutcome] => !!e),
      );
      setResolved(next);
    });
    return () => {
      active = false;
    };
  }, [games, walletAddress]);

  // Stay hidden while the gate resolves (undefined), then show the standard
  // unavailable copy when PvP is off — matching PvpGame's fallback.
  if (pvpEnabled === undefined) {
    return <p className="text-muted animate-pulse">Loading…</p>;
  }
  if (!pvpEnabled) {
    return (
      <div className="text-center text-muted px-4">
        PvP isn&apos;t available right now. Check back soon.
      </div>
    );
  }

  if (!walletAddress) {
    return (
      <div className="text-center text-muted px-4">
        Connect your Circles wallet to see your match history.
      </div>
    );
  }

  if (games === null) {
    return <p className="text-muted animate-pulse">Loading history…</p>;
  }

  const classified = games.map((g) => ({
    game: g,
    outcome: resolved[g.gameId] ?? outcomeFor(g, walletAddress),
  }));
  const visible = classified.filter(({ outcome }) => tabFor(outcome) === tab);

  return (
    <div className="flex flex-col gap-4 w-full max-w-lg mx-auto px-3">
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
              className={`px-3 py-1.5 rounded-full text-sm font-semibold transition-colors ${
                tab === t
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "bg-surface-2 text-muted hover:text-foreground"
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
        <p className="text-center text-faint text-sm py-8">
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
