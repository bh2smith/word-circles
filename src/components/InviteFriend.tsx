"use client";

import { useState } from "react";
import { shareInvite, type ShareResult } from "@/lib/circles";

interface InviteFriendProps {
  // Connected player address — tagged into the share link as the inviter.
  address: string;
  // Optional extra classes for layout tweaks at the call site.
  className?: string;
}

// A self-contained "invite a friend" share button. Shares a link back to the
// Word Circles mini-app via the native share sheet (mobile) or clipboard. No
// backend: referrals are scored host-side from the Circles team's analytics, so
// the link only needs to land the friend inside the app — see buildInviteUrl.
export default function InviteFriend({
  address,
  className,
}: InviteFriendProps) {
  const [result, setResult] = useState<ShareResult | null>(null);

  const onShare = async () => {
    const r = await shareInvite(address);
    setResult(r);
    // Reset the feedback after a moment so the button is reusable.
    if (r !== "failed") setTimeout(() => setResult(null), 2500);
  };

  const label =
    result === "copied"
      ? "Link copied!"
      : result === "shared"
        ? "Shared!"
        : result === "failed"
          ? "Couldn't share — try again"
          : "Invite a friend";

  return (
    <button
      onClick={onShare}
      className={`rounded-lg bg-neutral-700 px-5 py-2 text-sm font-bold text-white transition-colors hover:bg-neutral-600 ${className ?? ""}`}
    >
      {label}
    </button>
  );
}
