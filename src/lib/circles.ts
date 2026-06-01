"use client";

import {
  isMiniappMode,
  onWalletChange,
  sendTransactions,
  type Transaction,
} from "@aboutcircles/miniapp-sdk";
import { getAddress } from "viem";
import {
  encodeApprove,
  encodeGroupMint,
  encodeWrap,
  getErc20Balance,
  getPersonalCrcBalance,
  getTokenAvatar,
  HUB_ADDRESS,
  staticToDemurrage,
} from "./contract";

export { isMiniappMode };

export const CIRCLES_MINIAPP_URL =
  "https://circles.gnosis.io/miniapps/word-circles";

export function circlesProfileUrl(address: string): string {
  return `https://app.gnosis.io/${address}`;
}

export type WalletListener = (address: string | null) => void;

const listeners: Set<WalletListener> = new Set();
let currentAddress: string | null = null;
let initialized = false;
let sessionReported = false;

function reportMiniappSession(wallet: string) {
  fetch("/api/event", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wallet, kind: "miniapp_open" }),
    keepalive: true,
  }).catch(() => {});
}

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
    if (currentAddress && !sessionReported) {
      sessionReported = true;
      reportMiniappSession(currentAddress);
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

// Thrown when the player can't be lifted into the stake token because their
// personal CRC balance is below the demurraged collateral the groupMint needs.
// Carries both amounts so the UI can show the shortfall in CRC units.
export class NoCirclesError extends Error {
  readonly available: bigint;
  readonly required: bigint;
  constructor(available: bigint, required: bigint) {
    super("no-circles");
    this.name = "NoCirclesError";
    this.available = available;
    this.required = required;
  }
}

export interface JoinPvpParams {
  escrow: string;
  token: string;
  approveData: string;
  joinData: string;
  // Player address and static stake. When provided and the player holds < stake
  // of the group token (s-gCRC), we prepend groupMint + wrap to mint it from their
  // personal CRC. Omit to skip the lift (assumes the player already holds enough).
  player?: string;
  stake?: bigint;
}

// Enter PvP matchmaking in a single batched submission. If the player lacks the
// stake token, the batch is [groupMint, wrap, approve, join]; otherwise just
// [approve, join] (join does safeTransferFrom, so approval must come first). The
// (group, type=1) wrapper is already deployed and equals `token`, so approve can
// target it directly without reading wrap()'s return value. The group avatar is
// read from the token itself (token.avatar()), so no extra config is needed. The
// escrow assigns the gameId on-chain; discover it afterwards via
// GET /api/games?player=<address>.
//
// Throws NoCirclesError if the player holds neither the stake token nor any
// personal CRC the group can mint — i.e. they can't play.
export async function joinPvpGame(params: JoinPvpParams) {
  const { escrow, token, approveData, joinData, player, stake } = params;

  const lift: Transaction[] = [];
  if (player && stake !== undefined) {
    const held = await getErc20Balance(token, player);
    if (held < stake) {
      // Need to mint the shortfall from personal CRC. The wrap math runs in
      // demurraged units, so check the player has at least that much before
      // building the batch — otherwise groupMint reverts silently (0x) in the
      // wallet and the user sees a generic failure.
      const group = await getTokenAvatar(token);
      const wrapAmount = await staticToDemurrage(token, stake);
      const personal = await getPersonalCrcBalance(player);
      if (personal < wrapAmount) {
        throw new NoCirclesError(personal, wrapAmount);
      }
      lift.push(
        {
          to: HUB_ADDRESS,
          data: encodeGroupMint(group, [player], [wrapAmount]),
          value: "0x0",
        },
        { to: HUB_ADDRESS, data: encodeWrap(group, wrapAmount), value: "0x0" },
      );
    }
  }

  return sendTransactions([
    ...lift,
    { to: token, data: approveData, value: "0x0" },
    { to: escrow, data: joinData, value: "0x0" },
  ]);
}

// Re-exported so call sites build the approve calldata without a second import.
export { encodeApprove };

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
