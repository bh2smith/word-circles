"use client";

import { useEffect, useMemo, useState } from "react";
import {
  fetchGroupMemberships,
  getConnectedAddress,
  initCircles,
  subscribeWallet,
} from "@/lib/circles";
import type { ContractConfig, LobbyConfig } from "@/lib/api";

// Frontend build-time PvP opt-in. PvP UI only ever shows when BOTH this flag is
// set at build (NEXT_PUBLIC_PVP_ENABLED=true) AND the backend reports pvpEnabled
// at runtime — so the frontend can hold PvP back even when the backend is live.
// `NEXT_PUBLIC_*` is inlined at build, so flipping it requires a rebuild.
export const FRONTEND_PVP_ENABLED =
  process.env.NEXT_PUBLIC_PVP_ENABLED === "true";

export interface PvpLobbies {
  /** Full backend config (escrow/resolver/timeout). null while loading or off. */
  config: ContractConfig | null;
  /** True once the /api/config fetch has resolved (regardless of outcome). */
  configLoaded: boolean;
  /** Lobbies the player can actually enter: bot-funded ∩ their memberships. */
  visible: LobbyConfig[];
  /** Raw group memberships (lowercase 0x), or null until resolved. */
  memberships: string[] | null;
  /** The onboarding/default group (first configured lobby), lowercase 0x. */
  defaultGroup: string | null;
  /**
   * Master gate for the PvP UI: `pvpEnabled && visible.length > 0`. `undefined`
   * while config or memberships are still resolving so callers stay hidden (no
   * tab flicker), then `true`/`false`.
   */
  pvpEnabled: boolean | undefined;
}

// Per-user PvP visibility, superseding the static `usePvpEnabled`. Combines the
// backend's master `pvpEnabled` switch, the live per-lobby `botFunded` flag, and
// the player's Circles group memberships into the set of lobbies they can enter.
// An empty set means PvP is hidden entirely (no tab, no /pvp) — the bot-funded ∩
// membership filter governs only what we display, never who you play against.
//
// Keys off the connected wallet, which in the miniapp arrives via onWalletChange
// shortly after load; until both config and memberships resolve it returns
// `undefined` so the PvP section never flashes before we know it's enterable.
export function usePvpLobbies(): PvpLobbies {
  const [config, setConfig] = useState<ContractConfig | null>(null);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [address, setAddress] = useState<string | null>(getConnectedAddress());
  // Keyed by address so a stale result from a previous wallet is ignored until
  // the current address's fetch resolves (no synchronous reset needed).
  const [membershipData, setMembershipData] = useState<{
    address: string;
    groups: string[];
  } | null>(null);

  useEffect(() => {
    initCircles();
    const unsubscribe = subscribeWallet(setAddress);
    let active = true;
    fetch("/api/config")
      .then((r) => (r.ok ? r.json() : null))
      .then((cfg: ContractConfig | null) => {
        if (active) setConfig(cfg);
      })
      .catch(() => {
        if (active) setConfig(null);
      })
      .finally(() => {
        if (active) setConfigLoaded(true);
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!address) return;
    let active = true;
    fetchGroupMemberships(address).then((groups) => {
      if (active) setMembershipData({ address, groups });
    });
    return () => {
      active = false;
    };
  }, [address]);

  // null = not yet fetched for the current address; [] = fetched, no groups.
  const memberships =
    address && membershipData?.address === address
      ? membershipData.groups
      : null;

  const visible = useMemo(() => {
    if (!config || !memberships) return [];
    const member = new Set(memberships);
    // config.group is already lowercase 0x hex (backend token_key); memberships
    // are lowercased in fetchGroupMemberships.
    return config.lobbies.filter(
      (l) => l.botFunded && member.has(l.group.toLowerCase()),
    );
  }, [config, memberships]);

  let pvpEnabled: boolean | undefined;
  if (!FRONTEND_PVP_ENABLED) {
    pvpEnabled = false; // frontend opt-out: PvP stays dark regardless of backend
  } else if (!configLoaded) {
    pvpEnabled = undefined; // config still loading
  } else if (!config?.pvpEnabled) {
    pvpEnabled = false; // master kill-switch off or not configured
  } else if (!address || memberships === null) {
    pvpEnabled = undefined; // waiting on wallet / memberships
  } else {
    pvpEnabled = visible.length > 0;
  }

  const defaultGroup = config?.lobbies[0]?.group.toLowerCase() ?? null;

  return {
    config,
    configLoaded,
    visible,
    memberships,
    defaultGroup,
    pvpEnabled,
  };
}
