"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { usePvpEnabled } from "@/lib/usePvpEnabled";
import { FRONTEND_ZK_DUEL_ENABLED, ZK_DUEL_ADDRESS } from "@/lib/duel/frontend";

const TABS = [
  { href: "/", label: "Daily" },
  { href: "/pvp", label: "PvP" },
  { href: "/pvp/history", label: "History" },
] as const;

const ZK_DUEL_TAB = { href: "/zk-duel", label: "ZK Duel" } as const;

export default function ModeNav() {
  const pathname = usePathname();
  const pvpEnabled = usePvpEnabled();
  // PvP hidden until the backend reports it live — no nav at all, so the app
  // looks exactly like the daily-only version. Stays hidden while loading
  // (undefined) so we never flash a tab the backend can't serve.
  if (!pvpEnabled && !(FRONTEND_ZK_DUEL_ENABLED && ZK_DUEL_ADDRESS))
    return null;
  const tabs = [
    ...(pvpEnabled ? TABS : [TABS[0]]),
    ...(FRONTEND_ZK_DUEL_ENABLED && ZK_DUEL_ADDRESS ? [ZK_DUEL_TAB] : []),
  ];
  return (
    <nav className="flex justify-center pt-4">
      <div className="flex gap-1 rounded-full border border-border bg-surface/70 p-1 shadow-sm backdrop-blur">
        {tabs.map((t) => {
          // Exact match, so /pvp/history doesn't also light up the /pvp tab.
          const active = pathname === t.href;
          return (
            <Link
              key={t.href}
              href={t.href}
              className={`rounded-full px-4 py-1.5 text-sm font-semibold transition-colors ${
                active
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "text-muted hover:text-foreground hover:bg-primary-soft"
              }`}
            >
              {t.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
