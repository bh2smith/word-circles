"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { usePvpEnabled } from "@/lib/usePvpEnabled";

const TABS = [
  { href: "/", label: "Daily" },
  { href: "/pvp", label: "PvP" },
  { href: "/pvp/history", label: "History" },
] as const;

export default function ModeNav() {
  const pathname = usePathname();
  const pvpEnabled = usePvpEnabled();
  // PvP hidden until the backend reports it live — no nav at all, so the app
  // looks exactly like the daily-only version. Stays hidden while loading
  // (undefined) so we never flash a tab the backend can't serve.
  if (!pvpEnabled) return null;
  return (
    <nav className="flex justify-center gap-2 pt-4">
      {TABS.map((t) => {
        // Exact match, so /pvp/history doesn't also light up the /pvp tab.
        const active = pathname === t.href;
        return (
          <Link
            key={t.href}
            href={t.href}
            className={`px-4 py-1.5 rounded text-sm font-semibold transition-colors ${
              active
                ? "bg-green-600 text-white"
                : "bg-neutral-800 text-neutral-400 hover:text-white"
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
