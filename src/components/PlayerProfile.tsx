"use client";

import { useEffect, useState } from "react";
import {
  CirclesProfile,
  circlesProfileUrl,
  fetchCirclesProfiles,
} from "@/lib/circles";

function truncate(addr: string): string {
  return addr.length <= 10 ? addr : `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

// Resolve a single Circles profile, falling back to null while loading or when
// the address has no profile. Results are cached by fetchCirclesProfiles, so
// repeated calls for the same address don't re-hit the network.
export function useCirclesProfile(
  address: string | null | undefined,
): CirclesProfile | null {
  const [profile, setProfile] = useState<CirclesProfile | null>(null);
  useEffect(() => {
    if (!address) {
      // Clear any stale profile when the address is removed.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setProfile(null);
      return;
    }
    let active = true;
    fetchCirclesProfiles([address])
      .then((map) => {
        if (active) setProfile(map.get(address.toLowerCase()) ?? null);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [address]);
  return profile;
}

interface PlayerProfileProps {
  address: string;
  /** Avatar diameter. */
  size?: "sm" | "md";
  /** Link to the player's Circles profile (default true). */
  link?: boolean;
  className?: string;
}

// Renders a Circles player as avatar + name, linking to their profile. Falls
// back to a truncated address (and a placeholder avatar) when no profile or
// preview image is available.
export default function PlayerProfile({
  address,
  size = "sm",
  link = true,
  className = "",
}: PlayerProfileProps) {
  const profile = useCirclesProfile(address);
  const dim = size === "md" ? "w-7 h-7" : "w-5 h-5";
  const label = profile?.name ?? truncate(address);

  const inner = (
    <>
      {profile?.previewImageUrl ? (
        // Circles preview avatar from an arbitrary host/data URL; next/image
        // adds remotePatterns config + optimization cost with no benefit at
        // this size, so plain <img> is intentional.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={profile.previewImageUrl}
          alt=""
          className={`${dim} rounded-full shrink-0 object-cover`}
        />
      ) : (
        <div className={`${dim} rounded-full bg-surface-2 shrink-0`} />
      )}
      <span className="truncate">{label}</span>
    </>
  );

  if (!link) {
    return (
      <span className={`inline-flex items-center gap-2 min-w-0 ${className}`}>
        {inner}
      </span>
    );
  }

  return (
    <a
      href={circlesProfileUrl(address)}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex items-center gap-2 min-w-0 hover:text-primary transition-colors ${className}`}
    >
      {inner}
    </a>
  );
}
