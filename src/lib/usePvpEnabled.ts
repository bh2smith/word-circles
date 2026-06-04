"use client";

import { useEffect, useState } from "react";
import type { ContractConfig } from "@/lib/api";

// Frontend build-time PvP gate. PvP only appears when BOTH this flag is set at
// build time AND the backend reports pvpEnabled at runtime — both sides must
// agree before any PvP UI shows. Set NEXT_PUBLIC_PVP_ENABLED=true to opt the
// frontend in; leave it unset to ship the PvP code dark regardless of backend.
export const FRONTEND_PVP_ENABLED =
  process.env.NEXT_PUBLIC_PVP_ENABLED === "true";

// Combined PvP rollout gate. The backend owns runtime availability via
// /api/config (pvpEnabled); the frontend opts in via FRONTEND_PVP_ENABLED.
// Both must be true, so the UI can never offer a feature the backend can't
// serve, and the frontend can hold PvP back even when the backend is live.
//
// Returns `undefined` while loading so callers can stay hidden until both sides
// are known (dark-by-default), then `true`/`false`. Short-circuits to `false`
// without a fetch when the frontend flag is off.
export function usePvpEnabled(): boolean | undefined {
  const [enabled, setEnabled] = useState<boolean | undefined>(
    FRONTEND_PVP_ENABLED ? undefined : false,
  );

  useEffect(() => {
    if (!FRONTEND_PVP_ENABLED) return;
    let active = true;
    fetch("/api/config")
      .then((r) => (r.ok ? r.json() : null))
      .then((cfg: ContractConfig | null) => {
        if (active) setEnabled(Boolean(cfg?.pvpEnabled));
      })
      .catch(() => {
        if (active) setEnabled(false);
      });
    return () => {
      active = false;
    };
  }, []);

  return enabled;
}
