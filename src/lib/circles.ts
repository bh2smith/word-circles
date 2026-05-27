"use client";

import {
  isMiniappMode,
  onWalletChange,
  sendTransactions,
} from "@aboutcircles/miniapp-sdk";
import { getAddress } from "viem";

export { isMiniappMode };

export type WalletListener = (address: string | null) => void;

const listeners: Set<WalletListener> = new Set();
let currentAddress: string | null = null;
let initialized = false;

export function initCircles() {
  if (initialized) return;
  initialized = true;

  if (!isMiniappMode()) return;

  onWalletChange((address: string | null) => {
    try {
      currentAddress = address ? getAddress(address) : null;
    } catch {
      currentAddress = null;
    }
    listeners.forEach((fn) => fn(currentAddress));
  });
}

export function subscribeWallet(fn: WalletListener): () => void {
  listeners.add(fn);
  fn(currentAddress);
  return () => listeners.delete(fn);
}

export function getConnectedAddress(): string | null {
  return currentAddress;
}

export async function submitGameResult(
  contractAddress: string,
  calldata: string,
) {
  return sendTransactions([
    { to: contractAddress, data: calldata, value: "0x0" },
  ]);
}

// Enter PvP matchmaking: approve the escrow for the stake and call join() in a
// single batched submission (join does safeTransferFrom, so approval must come
// first). The escrow assigns the gameId on-chain; discover it afterwards via
// GET /api/games?player=<address>.
export async function joinPvpGame(
  escrow: string,
  token: string,
  approveData: string,
  joinData: string,
) {
  return sendTransactions([
    { to: token, data: approveData, value: "0x0" },
    { to: escrow, data: joinData, value: "0x0" },
  ]);
}

export interface CirclesProfile {
  name: string;
  address: string;
  previewImageUrl: string | null;
}

const profileCache = new Map<string, CirclesProfile>();

const PROFILES_API = "https://rpc.aboutcircles.com/profiles/search/addresses";

export async function fetchCirclesProfiles(
  addresses: string[],
): Promise<Map<string, CirclesProfile>> {
  const uncached = addresses.filter((a) => !profileCache.has(a.toLowerCase()));
  if (uncached.length > 0) {
    try {
      const res = await fetch(PROFILES_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          addresses: uncached,
          fetchComplete: true,
        }),
      });
      if (res.ok) {
        const profiles: CirclesProfile[] = await res.json();
        for (const p of profiles) {
          profileCache.set(p.address.toLowerCase(), p);
        }
      }
    } catch {
      // profiles are best-effort; fall back to truncated addresses
    }
  }
  const result = new Map<string, CirclesProfile>();
  for (const a of addresses) {
    const cached = profileCache.get(a.toLowerCase());
    if (cached) result.set(a.toLowerCase(), cached);
  }
  return result;
}
