"use client";

import { useState } from "react";
import { connectAccount } from "@/lib/circles";

interface ConnectAccountProps {
  // Optional extra classes for layout tweaks at the call site.
  className?: string;
  // Button label; defaults to the generic create-or-connect wording.
  label?: string;
}

// A "Create or connect Circles account" button for the disconnected state inside
// the Circles host. Calls the host's passkey flow directly from the click so the
// browser keeps the user gesture WebAuthn requires. On success the host emits a
// wallet change, which our subscribeWallet listeners pick up to re-render past
// the disconnected screen — so this component just handles the in-flight button
// state and a non-blocking error if the user cancels. Only render this when
// isMiniappMode() is true; outside the host there's no one to answer the request.
export default function ConnectAccount({
  className,
  label = "Create or connect Circles account",
}: ConnectAccountProps) {
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onClick = async () => {
    setConnecting(true);
    setError(null);
    try {
      await connectAccount();
      // Success path: onWalletChange fires and the parent unmounts this view.
    } catch (err) {
      // User dismissed the host flow, or it failed — keep the button usable.
      setError(
        err instanceof Error ? err.message : "Couldn't connect — try again.",
      );
    } finally {
      setConnecting(false);
    }
  };

  return (
    <div className={`flex flex-col items-center gap-2 ${className ?? ""}`}>
      <button
        onClick={onClick}
        disabled={connecting}
        className="px-6 py-2.5 rounded-lg bg-green-600 font-bold text-white hover:bg-green-500 transition-colors disabled:opacity-60"
      >
        {connecting ? "Connecting…" : label}
      </button>
      {error && (
        <p role="alert" className="text-sm text-red-400 text-center">
          {error}
        </p>
      )}
    </div>
  );
}
