"use client";

import {
  isMiniappMode,
  onWalletChange as sdkOnWalletChange,
  requestCreateAccount,
  sendTransactions as sdkSendTransactions,
  signMessage as sdkSignMessage,
  type SignResult,
  type Transaction,
} from "@aboutcircles/miniapp-sdk";
import { getAddress } from "viem";
import {
  encodeApprove,
  encodeGroupMint,
  encodeUnwrap,
  encodeWrap,
  getErc20Balance,
  getTokenAvatar,
  HUB_ADDRESS,
  isTrusted,
  staticToDemurrage,
} from "./contract";
import {
  connect as connectorConnect,
  disconnect as connectorDisconnect,
  onConnectorWalletChange,
  sendTransactions as connectorSendTransactions,
  signMessage as connectorSignMessage,
} from "./crcConnector";
import { api } from "./api/client";

export { isMiniappMode };

export const CIRCLES_MINIAPP_URL =
  "https://circles.gnosis.io/miniapps/word-circles";

export function circlesProfileUrl(address: string): string {
  return `https://app.gnosis.io/${address}`;
}

// A shareable link back to the Word Circles mini-app, tagged with the inviter's
// address so the landing screen can greet the newcomer ("X invited you"). The
// Circles host may strip the query param when it opens the embedded mini-app —
// that's fine, the link still lands them in the app; the ref is a best-effort
// bonus, not load-bearing. Referral *scoring* is done host-side (Mixpanel), not
// from this param, so there's deliberately no backend recording here.
export function buildInviteUrl(inviter: string): string {
  return `${CIRCLES_MINIAPP_URL}?ref=${inviter.toLowerCase()}`;
}

export type ShareResult = "shared" | "copied" | "failed";

// Share an invite link via the native share sheet (mobile), falling back to the
// clipboard. Returns which path succeeded so the UI can show the right feedback.
export async function shareInvite(inviter: string): Promise<ShareResult> {
  const url = buildInviteUrl(inviter);
  const text = "Come play Word Circles with me on Circles!";
  try {
    if (typeof navigator !== "undefined" && navigator.share) {
      await navigator.share({ title: "Word Circles", text, url });
      return "shared";
    }
  } catch {
    // User dismissed the share sheet, or it's unavailable — fall through to copy.
  }
  try {
    await navigator.clipboard.writeText(url);
    return "copied";
  } catch {
    return "failed";
  }
}

export type WalletListener = (address: string | null) => void;

const listeners: Set<WalletListener> = new Set();
let currentAddress: string | null = null;
let initialized = false;

// Standalone logins are remembered across reloads so a returning web visitor
// stays signed in. Embedded mode never persists — the host owns identity there.
const STORAGE_KEY = "word-circles:circles-address";

// Single funnel for connection changes from whichever transport is active.
// Normalizes to a checksum address, persists the standalone session, and
// notifies subscribers. No-ops when the address is unchanged.
function setCurrentAddress(raw: string | null): void {
  let next: string | null;
  try {
    next = raw ? getAddress(raw) : null;
  } catch {
    next = null;
  }
  if (next === currentAddress) return;
  currentAddress = next;
  if (!isMiniappMode()) persistAddress(next);
  listeners.forEach((fn) => fn(next));
}

function persistAddress(address: string | null): void {
  try {
    if (address) localStorage.setItem(STORAGE_KEY, address);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore private-mode / quota failures
  }
}

function restoreStoredAddress(): void {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) setCurrentAddress(stored);
  } catch {
    // ignore private-mode / quota failures
  }
}

/**
 * Wire up the active Circles transport. Embedded in the Circles host app we
 * track the miniapp SDK's wallet; standalone on the open web we drive the
 * `crc-signin` connector iframe and remember the last login across reloads.
 */
export function initCircles() {
  if (initialized) return;
  initialized = true;

  if (isMiniappMode()) {
    sdkOnWalletChange((address) => setCurrentAddress(address));
    return;
  }

  onConnectorWalletChange((address) => setCurrentAddress(address));
  restoreStoredAddress();
}

export function subscribeWallet(fn: WalletListener): () => void {
  listeners.add(fn);
  fn(currentAddress);
  return () => listeners.delete(fn);
}

export function getConnectedAddress(): string | null {
  return currentAddress;
}

/** True whenever a wallet is attached — embedded host or standalone login. */
export function isConnected(): boolean {
  return currentAddress !== null;
}

// Ask the host to open its passkey-backed "create or connect account" flow. The
// host owns account creation, login, and (for users arriving via a native invite
// link) the invitation flow — we just trigger it. MUST be called straight from a
// user gesture (click): browsers block the WebAuthn passkey prompt otherwise.
// Resolves with the address; rejects if the user cancels. The connection state
// itself propagates through onWalletChange/subscribeWallet, so callers generally
// don't need the return value — it's there for immediate button error handling.
export async function connectAccount(): Promise<string> {
  const { address } = await requestCreateAccount();
  return getAddress(address);
}

/**
 * Unified login entry used by the UI. Embedded → the host's passkey flow;
 * standalone → the crc-signin connector. Resolves with the address (null if a
 * standalone user dismisses the connector); the host flow rejects on cancel.
 */
export function connect(): Promise<string | null> {
  return isMiniappMode() ? connectAccount() : connectorConnect();
}

/** Log out of a standalone session. No-op when embedded (the host owns identity). */
export function disconnect(): void {
  if (isMiniappMode()) return;
  connectorDisconnect();
}

// Route a transaction batch through whichever transport is active.
function sendTransactions(transactions: Transaction[]): Promise<string[]> {
  return isMiniappMode()
    ? sdkSendTransactions(transactions)
    : connectorSendTransactions(transactions);
}

// Route a message signature through whichever transport is active.
function signMessage(message: string): Promise<SignResult> {
  return isMiniappMode()
    ? sdkSignMessage(message)
    : connectorSignMessage(message);
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
// usable Circles collateral — the target group's own tokens plus tokens of
// avatars the group trusts, un-wrapped (ERC-1155) or wrapped (ERC-20) — is
// below the demurraged amount the lift needs. Carries both amounts so the UI
// can show the shortfall in CRC units.
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
  // of the group token (s-gCRC), we prepend a lift that assembles it from the
  // Circles collateral they do hold (see joinPvpGame). Omit to skip the lift
  // (assumes the player already holds enough).
  player?: string;
  stake?: bigint;
}

// One Circles balance the lift can draw on: `avatar`'s tokens held by the
// player, either directly as ERC-1155 in the Hub (token = null) or inside an
// ERC-20 wrapper to unwrap first.
export interface LiftSource {
  // The avatar whose Circles these are — the ERC-1155 token id and, when the
  // target group has to mint, the groupMint collateral address. Lowercase.
  avatar: string;
  // The ERC-20 wrapper contract to call unwrap() on, or null when the balance
  // already sits un-wrapped in the Hub.
  token: string | null;
  // true = inflationary/static wrapper (unwrap amount is static), false =
  // demurraged wrapper (unwrap amount is demurraged, credited 1:1).
  inflationary: boolean;
  demurraged: bigint; // attoCircles
  staticAmount: bigint; // staticAttoCircles
}

interface TokenBalanceRow {
  tokenOwner: string;
  tokenAddress: string;
  attoCircles: string;
  staticAttoCircles: string;
  isErc20: boolean;
  isWrapped: boolean;
  isInflationary: boolean;
  isGroup: boolean;
}

// Every Circles balance the player holds, via the Circles JSON-RPC
// `circles_getTokenBalances`: ERC-1155 Hub balances (personal or group CRC) and
// v2 ERC-20 wrappers. Only v1 tokens (ERC-20 but not wrapped, so nothing to
// unwrap) are dropped; trust filtering is the caller's job. Best-effort:
// returns [] on any error, so the caller falls back to "no circles" rather
// than erroring.
export async function fetchLiftSources(player: string): Promise<LiftSource[]> {
  try {
    const res = await fetch(CIRCLES_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "circles_getTokenBalances",
        params: [player],
      }),
    });
    if (!res.ok) return [];
    const body: { result?: TokenBalanceRow[] } = await res.json();
    const out: LiftSource[] = [];
    for (const row of body.result ?? []) {
      if (!row.tokenOwner) continue;
      if (row.isErc20 && !row.isWrapped) continue; // v1 token, can't unwrap
      out.push({
        avatar: row.tokenOwner.toLowerCase(),
        token: row.isErc20 ? getAddress(row.tokenAddress) : null,
        inflationary: row.isInflationary,
        demurraged: BigInt(row.attoCircles),
        staticAmount: BigInt(row.staticAttoCircles),
      });
    }
    return out;
  } catch {
    return [];
  }
}

export interface LiftPlan {
  // unwrap() calls to free wrapped balances back into the Hub, in order.
  unwraps: { token: string; amount: bigint }[];
  // Parallel arrays for hub.groupMint — one entry per collateral avatar drawn
  // on. Both empty when the sources were all the target group's own tokens.
  mintOwners: string[];
  mintAmounts: bigint[];
}

// Decide how to assemble `need` demurraged CRC of the target `group`'s
// ERC-1155 tokens (which the final wrap converts into the stake ERC-20) from
// the player's balances. Sources are drained in cheapest-first order: the
// group's own ERC-1155 (no tx at all), then trusted ERC-1155 (mint only), then
// wrapped balances — demurraged wrappers before inflationary ones because
// unwrap() is exact there (1:1 in demurraged units). Inflationary wrappers are
// sized from their own static/demurraged ratio with a 1-wei cushion (unwrap
// floors the credited amount), capped at the balance; over-unwrapping only
// leaves the player spare un-wrapped CRC. Anything not owned by `group`
// becomes groupMint collateral. Returns null if the sources, summed, can't
// cover `need`. `group` and source avatars must be lowercase.
export function planLift(
  need: bigint,
  group: string,
  sources: LiftSource[],
): LiftPlan | null {
  const tier = (s: LiftSource) =>
    s.token ? (s.inflationary ? 3 : 2) : s.avatar === group ? 0 : 1;
  const ordered = [...sources].sort((a, b) => tier(a) - tier(b));
  const unwraps: { token: string; amount: bigint }[] = [];
  const mint = new Map<string, bigint>();
  let remaining = need;
  for (const s of ordered) {
    if (remaining <= 0n) break;
    if (s.demurraged <= 0n) continue;
    const take = remaining < s.demurraged ? remaining : s.demurraged;
    if (s.token) {
      if (!s.inflationary) {
        unwraps.push({ token: s.token, amount: take });
      } else if (take === s.demurraged) {
        unwraps.push({ token: s.token, amount: s.staticAmount });
      } else {
        let amount =
          (take * s.staticAmount + s.demurraged - 1n) / s.demurraged + 1n;
        if (amount > s.staticAmount) amount = s.staticAmount;
        unwraps.push({ token: s.token, amount });
      }
    }
    if (s.avatar !== group)
      mint.set(s.avatar, (mint.get(s.avatar) ?? 0n) + take);
    remaining -= take;
  }
  if (remaining > 0n) return null;
  return {
    unwraps,
    mintOwners: [...mint.keys()],
    mintAmounts: [...mint.values()],
  };
}

// Enter PvP matchmaking in a single batched submission. If the player lacks the
// stake token, a lift is prepended that assembles it from whatever Circles
// collateral the target group accepts: the group's own tokens (held as ERC-1155
// or wrapped — no mint needed, just [unwrap?, wrap]), personal CRC, or another
// group's tokens (e.g. Gnosis gCRC) — anything owned by an avatar the group
// trusts — unwrapped as needed and fed through groupMint. So the batch is
// [unwraps?, groupMint?, wrap, approve, join]; or just [approve, join] when the
// stake token is already held (join does safeTransferFrom, so approval must
// come first). The (group, type=1) wrapper is already deployed and equals
// `token`, so approve can target it directly without reading wrap()'s return
// value. The group avatar is read from the token itself (token.avatar()), so no
// extra config is needed. The escrow assigns the gameId on-chain; discover it
// afterwards via GET /api/games?player=<address>.
//
// Throws NoCirclesError if the player holds neither the stake token nor enough
// group-accepted collateral — un-wrapped or wrapped — i.e. they can't play.
export async function joinPvpGame(params: JoinPvpParams) {
  const { escrow, token, approveData, joinData, player, stake } = params;

  const lift: Transaction[] = [];
  if (player && stake !== undefined) {
    const held = await getErc20Balance(token, player);
    if (held < stake) {
      // The lift math runs in demurraged units, so plan against the player's
      // balances before building the batch — otherwise groupMint/wrap reverts
      // silently (0x) in the wallet and the user sees a generic failure.
      const group = await getTokenAvatar(token);
      const wrapAmount = await staticToDemurrage(token, stake);
      const groupKey = group.toLowerCase();
      const sources = await fetchLiftSources(player);

      // groupMint only accepts collateral from avatars the group trusts, so
      // filter each candidate owner through hub.isTrusted (a handful of
      // parallel eth_calls — the group's full trust list can be huge). The
      // group's own tokens need no trust: they skip the mint entirely.
      const owners = [...new Set(sources.map((s) => s.avatar))].filter(
        (a) => a !== groupKey,
      );
      const flags = await Promise.all(owners.map((a) => isTrusted(group, a)));
      const trusted = new Set(owners.filter((_, i) => flags[i]));
      const usable = sources.filter(
        (s) => s.avatar === groupKey || trusted.has(s.avatar),
      );

      const plan = planLift(wrapAmount, groupKey, usable);
      if (!plan) {
        const available = usable.reduce((sum, s) => sum + s.demurraged, 0n);
        throw new NoCirclesError(available, wrapAmount);
      }
      for (const u of plan.unwraps) {
        lift.push({ to: u.token, data: encodeUnwrap(u.amount), value: "0x0" });
      }
      if (plan.mintOwners.length > 0) {
        lift.push({
          to: HUB_ADDRESS,
          data: encodeGroupMint(group, plan.mintOwners, plan.mintAmounts),
          value: "0x0",
        });
      }
      lift.push({
        to: HUB_ADDRESS,
        data: encodeWrap(group, wrapAmount),
        value: "0x0",
      });
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

const CIRCLES_RPC = "https://rpc.aboutcircles.com";
const PROFILES_API = `${CIRCLES_RPC}/profiles/search/addresses`;

// The exact string the player signs to prove control of their address before
// the backend trusts them into the group. Must match `group_join_message` in
// backend/src/lib.rs byte-for-byte (lowercased address).
export function groupJoinMessage(player: string): string {
  return `Join Word Circles PvP group\nAddress: ${player.toLowerCase()}`;
}

// Onboards a player into the PvP group: signs a proof-of-control message (the
// avatar is a Safe, so this is an ERC-1271 signature via the host) and asks the
// backend (the group's service) to trust them on-chain. Server-side this also
// requires a recorded play. Idempotent. Returns true on success. The new
// membership takes a few seconds to index before the PvP gate (usePvpLobbies)
// picks it up.
export async function joinGroup(player: string): Promise<boolean> {
  try {
    // Default signatureType 'erc1271' → host EIP-191-hashes the message, which
    // the backend verifies via the avatar's isValidSignature.
    const { signature } = await signMessage(groupJoinMessage(player));
    const { data } = await api.POST("/api/group/join", {
      body: { player, signature },
    });
    return Boolean(data?.joined);
  } catch {
    // User rejected the signature, or the request failed.
    return false;
  }
}

interface GroupMembershipRow {
  group: string;
  member: string;
  // ms? no — seconds since epoch; sentinel huge value = never expires.
  expiryTime: number;
}

// Group avatars an address is currently a member of (lowercase), via the Circles
// JSON-RPC `circles_getGroupMemberships`. This is a JSON-RPC method (not a
// contract call), so it mirrors the fetch-based `fetchCirclesProfiles` rather
// than a viem readContract. Expired memberships are filtered out. A single
// request with a generous limit covers any realistic per-user membership count,
// so we don't paginate. Best-effort: returns [] on any error so PvP simply
// stays hidden rather than erroring.
export async function fetchGroupMemberships(
  address: string,
): Promise<string[]> {
  try {
    const res = await fetch(CIRCLES_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "circles_getGroupMemberships",
        params: [address, 100],
      }),
    });
    if (!res.ok) return [];
    const body: { result?: { results?: GroupMembershipRow[] } } =
      await res.json();
    const rows = body.result?.results ?? [];
    const nowSecs = Math.floor(Date.now() / 1000);
    const groups = new Set<string>();
    for (const row of rows) {
      if (row.expiryTime > nowSecs && row.group) {
        groups.add(row.group.toLowerCase());
      }
    }
    return [...groups];
  } catch {
    return [];
  }
}

const trustedCache = new Map<string, string[]>();

// Addresses the given avatar trusts (outgoing trust edges), lowercased and
// deduped, via the Circles JSON-RPC `circles_query` against the
// `V_Crc_TrustRelations` view. This is the same source the SDK's
// `getAggregatedTrustRelations` pages over, but "My Circle" only needs outgoing
// edges (`truster == avatar`), so one filtered query is enough — no need to
// pull in the heavy @circles-sdk. The view already excludes expired/revoked
// trust. The avatar itself is dropped (the caller adds it explicitly).
// Best-effort and cached per avatar: returns [] on any error so the circle
// scope just falls back to an empty board rather than erroring.
export async function fetchTrustedAddresses(
  address: string,
): Promise<string[]> {
  const key = address.toLowerCase();
  const cached = trustedCache.get(key);
  if (cached) return cached;
  try {
    const res = await fetch(CIRCLES_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "circles_query",
        params: [
          {
            Namespace: "V_Crc",
            Table: "TrustRelations",
            Columns: ["truster", "trustee"],
            Filter: [
              {
                Type: "FilterPredicate",
                FilterType: "Equals",
                Column: "truster",
                Value: key,
              },
            ],
            Order: [],
            Limit: 1000,
          },
        ],
      }),
    });
    if (!res.ok) return [];
    const body: { result?: { columns?: string[]; rows?: unknown[][] } } =
      await res.json();
    const columns = body.result?.columns ?? [];
    const rows = body.result?.rows ?? [];
    const trusteeIdx = columns.indexOf("trustee");
    if (trusteeIdx === -1) return [];
    const trusted = new Set<string>();
    for (const row of rows) {
      const trustee = row[trusteeIdx];
      if (typeof trustee === "string") trusted.add(trustee.toLowerCase());
    }
    trusted.delete(key);
    const result = [...trusted];
    trustedCache.set(key, result);
    return result;
  } catch {
    return [];
  }
}

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
