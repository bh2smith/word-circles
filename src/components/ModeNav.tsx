"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { PVP_ENABLED } from "@/lib/flags";

const TABS = [
  { href: "/", label: "Daily" },
  { href: "/pvp", label: "PvP" },
] as const;

export default function ModeNav() {
  const pathname = usePathname();
  // PvP hidden until the backend is live — no nav at all, so the app looks
  // exactly like the daily-only version.
  if (!PVP_ENABLED) return null;
  return (
    <nav className="flex justify-center gap-2 pt-4">
      {TABS.map((t) => {
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
