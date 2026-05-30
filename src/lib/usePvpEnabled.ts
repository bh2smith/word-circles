"use client";

import { useEffect, useState } from "react";
import type { ContractConfig } from "@/lib/api";

// Runtime PvP rollout gate. The backend owns availability via /api/config
// (pvpEnabled), so the frontend can ship the PvP code dark and light up the
// moment the backend flips the flag — no rebuild, and the UI can never offer a
// feature the backend can't serve. Replaces the old build-time
// NEXT_PUBLIC_PVP_ENABLED flag.
//
// Returns `undefined` while loading so callers can stay hidden until the
// backend answers (matching the previous dark-by-default behaviour), then
// `true`/`false` once known.
export function usePvpEnabled(): boolean | undefined {
  const [enabled, setEnabled] = useState<boolean | undefined>(undefined);

  useEffect(() => {
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
