"use client";

import { usePvpLobbies } from "@/lib/usePvpLobbies";

// Frontend build-time PvP opt-in (NEXT_PUBLIC_PVP_ENABLED). Defined in
// usePvpLobbies so it's folded into the per-player gate once, and every PvP
// surface (nav, /pvp, history, onboarding) honors it. Re-exported here for
// callers that gate on the raw flag (e.g. PvpGame's master switch).
export { FRONTEND_PVP_ENABLED } from "@/lib/usePvpLobbies";

// Thin derive over usePvpLobbies for callers that only need the on/off gate.
// PvP is "enabled" for a player iff the frontend opted in, the backend master
// switch is on, AND they have at least one enterable lobby. Returns `undefined`
// while loading so callers stay hidden. See usePvpLobbies for the full set.
export function usePvpEnabled(): boolean | undefined {
  return usePvpLobbies().pvpEnabled;
}
