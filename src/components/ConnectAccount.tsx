"use client";

import { useState } from "react";
import { connect } from "@/lib/circles";

interface ConnectAccountProps {
  // Optional extra classes for layout tweaks at the call site.
  className?: string;
  // Button label; defaults to the generic create-or-connect wording.
  label?: string;
}

// A "Login with Circles" button for the disconnected state. Calls the unified
// connect() directly from the click so the browser keeps the user gesture
// WebAuthn requires: embedded, that's the host's passkey flow; standalone, it
// opens the crc-signin connector iframe. On success the connection propagates
// through subscribeWallet, re-rendering past the disconnected screen — so this
// component just handles the in-flight button state and a non-blocking error.
export default function ConnectAccount({
  className,
  label = "Login with Circles",
}: ConnectAccountProps) {
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onClick = async () => {
    setConnecting(true);
    setError(null);
    try {
      await connect();
      // Success path: subscribeWallet fires and the parent unmounts this view.
      // A standalone dismissal resolves null (no error) and just re-enables the
      // button below.
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
        className="px-6 py-2.5 rounded-full bg-primary font-bold text-primary-foreground shadow-sm transition hover:opacity-90 active:scale-95 disabled:opacity-60"
      >
        {connecting ? "Connecting…" : label}
      </button>
      {error && (
        <p role="alert" className="text-sm text-secondary text-center">
          {error}
        </p>
      )}
    </div>
  );
}
