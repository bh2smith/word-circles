"use client";

import { useEffect, useState } from "react";
import { isAddress } from "viem";
import { fetchCirclesProfiles } from "@/lib/circles";

// Greets a newcomer who arrived via an invite link (?ref=<inviter>). Resolves
// the inviter's Circles profile for a friendly "X invited you" line and renders
// nothing when there's no ref, the ref isn't an address, or it can't resolve a
// name — so it's safe to mount unconditionally. Best-effort and presentational
// only: referral attribution happens host-side, not here.
export default function InviteWelcome() {
  const [name, setName] = useState<string | null>(null);

  useEffect(() => {
    const ref = new URLSearchParams(window.location.search).get("ref");
    if (!ref || !isAddress(ref)) return;
    let active = true;
    fetchCirclesProfiles([ref])
      .then((profiles) => {
        const profile = profiles.get(ref.toLowerCase());
        if (active && profile?.name) setName(profile.name);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  if (!name) return null;

  return (
    <div className="w-full max-w-md rounded-lg bg-green-900/40 px-4 py-3 text-center text-sm text-green-100">
      🎉 <span className="font-semibold">{name}</span> invited you to Word
      Circles — solve today&apos;s word to challenge them!
    </div>
  );
}
