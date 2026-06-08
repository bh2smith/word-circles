"use client";

import { useEffect, useRef, useState } from "react";
import { fetchCirclesProfiles, type CirclesProfile } from "@/lib/circles";
import type { LobbyConfig } from "@/lib/api";

interface GroupPickerProps {
  // Already filtered to the player's memberships by usePvpLobbies — the picker
  // does no fetching of its own beyond group profiles (name + avatar).
  lobbies: LobbyConfig[];
  selected: LobbyConfig | null;
  onSelect: (lobby: LobbyConfig) => void;
}

function GroupAvatar({
  profile,
  name,
}: {
  profile: CirclesProfile | undefined;
  name: string;
}) {
  if (profile?.previewImageUrl) {
    return (
      // Circles profile preview avatar: a tiny image from an arbitrary
      // host/data URL. next/image would need wildcard remotePatterns and adds
      // optimization cost with no benefit at this size, so plain <img> is right.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={profile.previewImageUrl}
        alt=""
        className="w-6 h-6 rounded-full object-cover bg-neutral-700"
      />
    );
  }
  // Fallback: first letter of the group name on a neutral disc.
  return (
    <span className="flex w-6 h-6 items-center justify-center rounded-full bg-neutral-700 text-xs font-bold uppercase">
      {name.charAt(0)}
    </span>
  );
}

// Group selector for the PvP lobby screen. With a single visible lobby it
// renders a static label (the common case for a member of one supported group);
// with several it's a dropdown of name + Circles profile avatar. No empty state
// — an empty `visible` means PvP was never shown in the first place.
export default function GroupPicker({
  lobbies,
  selected,
  onSelect,
}: GroupPickerProps) {
  const [profiles, setProfiles] = useState<Map<string, CirclesProfile>>(
    new Map(),
  );
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (lobbies.length === 0) return;
    let active = true;
    fetchCirclesProfiles(lobbies.map((l) => l.group)).then((m) => {
      if (active) setProfiles(m);
    });
    return () => {
      active = false;
    };
  }, [lobbies]);

  // Close the dropdown on an outside click.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open]);

  if (lobbies.length === 0) return null;

  const nameFor = (l: LobbyConfig) =>
    profiles.get(l.group.toLowerCase())?.name || l.name;

  // Single lobby: static label, no dropdown affordance.
  if (lobbies.length === 1) {
    const l = lobbies[0];
    return (
      <div className="flex items-center gap-2 rounded-lg bg-neutral-800 px-4 py-2">
        <GroupAvatar
          profile={profiles.get(l.group.toLowerCase())}
          name={l.name}
        />
        <span className="text-sm font-semibold text-white">{nameFor(l)}</span>
      </div>
    );
  }

  const current = selected ?? lobbies[0];

  return (
    <div ref={ref} className="relative w-full max-w-xs">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 rounded-lg bg-neutral-800 px-4 py-2 hover:bg-neutral-700 transition-colors"
      >
        <span className="flex items-center gap-2">
          <GroupAvatar
            profile={profiles.get(current.group.toLowerCase())}
            name={current.name}
          />
          <span className="text-sm font-semibold text-white">
            {nameFor(current)}
          </span>
        </span>
        <span className="text-neutral-400 text-xs">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg border border-neutral-700 bg-neutral-800 shadow-lg">
          {lobbies.map((l) => {
            const isSelected = l.token === current.token;
            return (
              <li key={l.token}>
                <button
                  type="button"
                  onClick={() => {
                    onSelect(l);
                    setOpen(false);
                  }}
                  className={`flex w-full items-center gap-2 px-4 py-2 text-left text-sm transition-colors hover:bg-neutral-700 ${
                    isSelected ? "text-green-400" : "text-white"
                  }`}
                >
                  <GroupAvatar
                    profile={profiles.get(l.group.toLowerCase())}
                    name={l.name}
                  />
                  <span className="font-semibold">{nameFor(l)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
