"use client";

import { useEffect, useRef, useState } from "react";
import {
  CirclesProfile,
  connect,
  disconnect,
  fetchCirclesProfiles,
  getConnectedAddress,
  initCircles,
  isMiniappMode,
  subscribeWallet,
} from "@/lib/circles";

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

const glyph = (
  <svg
    viewBox="0 0 24 24"
    width="15"
    height="15"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    aria-hidden="true"
    className="shrink-0"
  >
    <circle cx="9" cy="12" r="6" />
    <circle cx="15" cy="12" r="6" />
  </svg>
);

const chipClass =
  "flex items-center gap-2 rounded-full border border-border bg-surface/80 px-3 py-1.5 text-sm font-semibold text-foreground shadow-sm backdrop-blur transition-colors hover:bg-primary-soft";

/**
 * Persistent "Login with Circles" chip, shown only on the open web. Embedded in
 * the Circles host the identity is owned by the host, so the chip stays hidden
 * there. Logged out → a login button; logged in → the avatar/name with a logout
 * menu. Connection state flows through subscribeWallet.
 */
export default function CirclesLoginChip() {
  const [address, setAddress] = useState<string | null>(getConnectedAddress());
  // Tagged with the address it belongs to so a stale profile from a previous
  // login can't flash after an account switch.
  const [profile, setProfile] = useState<{
    address: string;
    data: CirclesProfile | null;
  } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    initCircles();
    return subscribeWallet(setAddress);
  }, []);

  // Resolve the connected avatar's name/picture. Guarded against a logout/switch
  // landing mid-lookup both by `live` and by tagging the result with `address`.
  useEffect(() => {
    if (!address) return;
    let live = true;
    fetchCirclesProfiles([address]).then((map) => {
      if (live) {
        setProfile({ address, data: map.get(address.toLowerCase()) ?? null });
      }
    });
    return () => {
      live = false;
    };
  }, [address]);

  // Close the menu on an outside click.
  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, [menuOpen]);

  // Embedded host owns identity — no chip.
  if (isMiniappMode()) return null;

  if (!address) {
    return (
      <div className="fixed right-3 top-3 z-40">
        <button onClick={() => connect()} className={chipClass}>
          {glyph}
          Login with Circles
        </button>
      </div>
    );
  }

  // Only use a profile resolved for the currently connected address.
  const shown = profile?.address === address ? profile.data : null;
  const name = shown?.name ?? shortAddr(address);
  return (
    <div ref={menuRef} className="fixed right-3 top-3 z-40">
      <button
        onClick={() => setMenuOpen((o) => !o)}
        aria-expanded={menuOpen}
        className={chipClass}
      >
        {shown?.previewImageUrl ? (
          // Circles preview avatar from an arbitrary host/data URL; plain <img>
          // is intentional (matches the leaderboard avatars).
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={shown.previewImageUrl}
            alt=""
            className="h-5 w-5 rounded-full"
          />
        ) : (
          <span className="h-5 w-5 rounded-full bg-surface-2" />
        )}
        <span className="max-w-[8rem] truncate">{name}</span>
      </button>
      {menuOpen && (
        <div className="absolute right-0 mt-1 w-40 rounded-xl border border-border bg-surface p-1 shadow-lg">
          <div className="px-3 py-1.5 text-xs text-muted">
            {shortAddr(address)}
          </div>
          <button
            onClick={() => {
              setMenuOpen(false);
              disconnect();
            }}
            className="w-full rounded-lg px-3 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-primary-soft"
          >
            Log out
          </button>
        </div>
      )}
    </div>
  );
}
