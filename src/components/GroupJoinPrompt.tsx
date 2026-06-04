"use client";

import { useState } from "react";
import { joinGroup } from "@/lib/circles";
import { FRONTEND_PVP_ENABLED, usePvpLobbies } from "@/lib/usePvpLobbies";

interface GroupJoinPromptProps {
  // Connected player address — required to trust them into the group.
  address: string;
}

// Shown after a daily win to a player who isn't yet in the onboarding group
// (the first configured lobby, e.g. WordGames). Tapping Join asks the backend to
// trust them on-chain, which unlocks PvP on the next membership refresh. Renders
// nothing if PvP is already available to them, they're already a member, or no
// group is configured — so it's safe to mount unconditionally on a win.
export default function GroupJoinPrompt({ address }: GroupJoinPromptProps) {
  const { config, memberships, defaultGroup, pvpEnabled } = usePvpLobbies();
  const [state, setState] = useState<"idle" | "joining" | "done" | "error">(
    "idle",
  );

  // Nothing to offer: frontend opted out of PvP, not configured, still loading,
  // or already has access.
  if (!FRONTEND_PVP_ENABLED) return null; // PvP held back on the frontend
  if (!defaultGroup || memberships === null) return null;
  if (pvpEnabled) return null; // already enterable somewhere
  if (memberships.includes(defaultGroup)) return null; // already a member

  const groupName = config?.lobbies[0]?.name ?? "the group";

  if (state === "done") {
    return (
      <div className="w-full max-w-md rounded-lg bg-neutral-800 px-4 py-3 text-center text-sm text-neutral-200">
        🎉 You&apos;re in <span className="font-semibold">{groupName}</span>!
        PvP unlocks shortly — check the PvP tab in a moment.
      </div>
    );
  }

  const onJoin = async () => {
    setState("joining");
    const ok = await joinGroup(address);
    setState(ok ? "done" : "error");
  };

  return (
    <div className="flex w-full max-w-md flex-col items-center gap-2 rounded-lg bg-neutral-800 px-4 py-3 text-center">
      <p className="text-sm text-neutral-200">
        Nice solve! Join <span className="font-semibold">{groupName}</span> to
        unlock head-to-head <span className="font-semibold">PvP</span> and stake
        CRC against other players.
      </p>
      <button
        onClick={onJoin}
        disabled={state === "joining"}
        className="rounded-lg bg-green-600 px-5 py-2 text-sm font-bold text-white transition-colors hover:bg-green-500 disabled:opacity-50"
      >
        {state === "joining" ? "Joining…" : `Join ${groupName}`}
      </button>
      {state === "error" && (
        <p className="text-xs text-red-400">
          Couldn&apos;t join right now — try again later.
        </p>
      )}
      <p className="text-xs text-neutral-500">
        You&apos;ll need some personal CRC to stake — claim your daily CRC in
        the Circles app.
      </p>
    </div>
  );
}
