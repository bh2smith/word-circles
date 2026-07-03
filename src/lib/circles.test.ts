import { beforeEach, describe, expect, mock, test } from "bun:test";
import { decodeFunctionData, getAddress } from "viem";
import * as realContract from "./contract";
import { hubAbi, wrapperAbi } from "./contract";

// joinPvpGame decides whether to prepend a lift (unwraps + groupMint + wrap)
// before the approve+join, assembling the stake token from whatever Circles
// collateral the target group accepts: the group's own tokens (no mint), or
// tokens of avatars the group trusts (personal CRC, other groups' gCRC). We
// stub the on-chain *reads* of ./contract (spreading the real module so its
// encoders/ABIs stay intact for other test files — mock.module is global), the
// wallet (miniapp SDK), and the Circles RPC (global fetch), then assert the
// batch joinPvpGame submits.
//
// The decision inputs:
//   held       = getErc20Balance(token, player)    — s-gCRC the player already has
//   wrapAmount = staticToDemurrage(token, stake)   — demurraged collateral the lift needs
//   sources    = circles_getTokenBalances(player)  — every Circles balance they hold
//   trusted    = hub.isTrusted(group, owner)       — which owners the group accepts
let held = 0n;
let wrapAmount = 0n;
let trusted = new Set<string>();
let tokenRows: Record<string, unknown>[] = [];
let sent: { to: string; data: string }[][] = [];

const GROUP = "0xC19BC204eb1c1D5B3FE500E5E5dfaBaB625F286c";
const TOKEN = "0xeeF7B1f06B092625228C835Dd5D5B14641D1e54A";
const PLAYER = "0x09c24767a7f9f7b1d021189b68f7a5aea3cee458"; // twalther
const ESCROW = "0x0000000000000000000000000000000000000E5C";
// twalther's own demurraged wrapper, holding his 103 CRC (from the bug report).
const WRAPPER = "0xa2713c354fdb82ceb9df0b03badf0c9c9cc5eb61";
// The Gnosis group avatar (everyone holds its gCRC since the balance migration).
const GNOSIS = "0x93ed5a96347927ff6ff6b790f8cf5258240c321f";
const HUB = realContract.HUB_ADDRESS;
const APPROVE = "0xapprovedata";
const JOIN = "0xjoindata";

mock.module("@aboutcircles/miniapp-sdk", () => ({
  isMiniappMode: () => true,
  onWalletChange: () => {},
  requestCreateAccount: async () => ({ authenticated: true, address: PLAYER }),
  sendTransactions: async (txs: { to: string; data: string }[]) => {
    sent.push(txs);
    return { hash: "0x" };
  },
  signMessage: async () => ({ signature: "0x" }),
}));

mock.module("./api/client", () => ({
  api: { POST: async () => ({ data: {} }) },
}));

// Spread the real module so erc20Abi, the encoders, etc. stay real for
// contract.test.ts; override only the four on-chain reads joinPvpGame makes.
mock.module("./contract", () => ({
  ...realContract,
  getErc20Balance: async () => held,
  getTokenAvatar: async () => GROUP,
  staticToDemurrage: async () => wrapAmount,
  isTrusted: async (_truster: string, trustee: string) =>
    trusted.has(trustee.toLowerCase()),
}));

const { joinPvpGame, NoCirclesError, planLift } = await import("./circles");

const CRC = 10n ** 18n;
const STAKE = 1n * CRC; // 1 CRC entry stake
// twalther's un-wrapped ERC-1155 balance from the indexer: 0.00000019 CRC dust.
const DUST = 187280813809n;

function demurragedRow(
  owner: string,
  demurraged: bigint,
  staticAmount: bigint,
) {
  return {
    tokenOwner: owner,
    tokenAddress: WRAPPER,
    attoCircles: demurraged.toString(),
    staticAttoCircles: staticAmount.toString(),
    isErc20: true,
    isWrapped: true,
    isInflationary: false,
    isGroup: false,
  };
}

// An un-wrapped ERC-1155 Hub balance of `owner`'s Circles (personal or group).
function erc1155Row(owner: string, demurraged: bigint) {
  return {
    tokenOwner: owner,
    tokenAddress: HUB,
    attoCircles: demurraged.toString(),
    staticAttoCircles: demurraged.toString(),
    isErc20: false,
    isWrapped: false,
    isInflationary: false,
    isGroup: owner.toLowerCase() !== PLAYER,
  };
}

function call() {
  return joinPvpGame({
    escrow: ESCROW,
    token: TOKEN,
    approveData: APPROVE,
    joinData: JOIN,
    player: PLAYER,
    stake: STAKE,
  });
}

// Summarise the submitted batch as [function-name, target] pairs. The lift txs
// (unwrap/groupMint/wrap) carry real calldata we decode; approve/join are the
// opaque pre-built blobs passed in, matched by their raw data.
function batch() {
  return sent[0].map((tx) => {
    if (tx.data === APPROVE) return { fn: "approve", to: tx.to };
    if (tx.data === JOIN) return { fn: "join", to: tx.to };
    const { functionName } = decodeFunctionData({
      abi: [...hubAbi, ...wrapperAbi],
      data: tx.data as `0x${string}`,
    });
    return { fn: functionName, to: tx.to };
  });
}

function unwrapAmount(tx: { data: string }) {
  const { functionName, args } = decodeFunctionData({
    abi: wrapperAbi,
    data: tx.data as `0x${string}`,
  });
  if (functionName !== "unwrap")
    throw new Error(`expected unwrap, got ${functionName}`);
  return args[0] as bigint;
}

function groupMintArgs(tx: { data: string }) {
  const { functionName, args } = decodeFunctionData({
    abi: hubAbi,
    data: tx.data as `0x${string}`,
  });
  if (functionName !== "groupMint")
    throw new Error(`expected groupMint, got ${functionName}`);
  return { collateral: args[1] as string[], amounts: args[2] as bigint[] };
}

beforeEach(() => {
  sent = [];
  tokenRows = [];
  held = 0n;
  wrapAmount = STAKE; // round-trips to ~the stake
  trusted = new Set([PLAYER]); // the player is a group member
  // Stub the Circles RPC (circles_getTokenBalances) used by fetchLiftSources.
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({ jsonrpc: "2.0", id: 1, result: tokenRows }),
  })) as unknown as typeof fetch;
});

describe("joinPvpGame lift decision", () => {
  test("already holds the stake token — submits just [approve, join]", async () => {
    held = STAKE;
    await call();
    expect(sent).toHaveLength(1);
    expect(batch()).toEqual([
      { fn: "approve", to: TOKEN },
      { fn: "join", to: ESCROW },
    ]);
  });

  test("holds enough un-wrapped personal CRC — lifts with [mint, wrap, approve, join]", async () => {
    held = 0n;
    tokenRows = [erc1155Row(PLAYER, 100n * CRC)]; // plenty of ERC-1155 in the Hub
    await call();
    expect(batch()).toEqual([
      { fn: "groupMint", to: HUB },
      { fn: "wrap", to: HUB },
      { fn: "approve", to: TOKEN },
      { fn: "join", to: ESCROW },
    ]);
    expect(groupMintArgs(sent[0][0])).toEqual({
      collateral: [getAddress(PLAYER)],
      amounts: [STAKE],
    });
  });

  // The post-migration common case: no personal CRC, but a Gnosis group token
  // balance. The group trusts the Gnosis avatar, so its gCRC serves as the
  // groupMint collateral.
  test("holds another group's tokens — mints with them as collateral", async () => {
    held = 0n;
    trusted = new Set([PLAYER, GNOSIS]);
    tokenRows = [erc1155Row(GNOSIS, 5n * CRC)];
    await call();
    expect(batch()).toEqual([
      { fn: "groupMint", to: HUB },
      { fn: "wrap", to: HUB },
      { fn: "approve", to: TOKEN },
      { fn: "join", to: ESCROW },
    ]);
    expect(groupMintArgs(sent[0][0])).toEqual({
      collateral: [getAddress(GNOSIS)],
      amounts: [STAKE],
    });
  });

  // Staking into the group whose tokens the player already holds as ERC-1155:
  // no mint at all, the wrap alone converts them into the stake ERC-20.
  test("holds the target group's own ERC-1155 — lifts with just [wrap, approve, join]", async () => {
    held = 0n;
    tokenRows = [erc1155Row(GROUP, 5n * CRC)]; // GROUP isn't in `trusted` — not needed
    await call();
    expect(batch()).toEqual([
      { fn: "wrap", to: HUB },
      { fn: "approve", to: TOKEN },
      { fn: "join", to: ESCROW },
    ]);
  });

  // Regression for the twalther report (0x09c2…e458): can't enter PvP in either
  // group, "not enough Circles to stake", despite confirmed 103 personal CRC.
  // His CRC sits in a demurraged ERC-20 wrapper; the un-wrapped Hub balance is
  // dust. We unwrap exactly the shortfall first.
  test("wrapped-only CRC — unwraps the shortfall, then [unwrap, mint, wrap, approve, join]", async () => {
    held = 0n;
    tokenRows = [
      erc1155Row(PLAYER, DUST), // un-wrapped Hub balance is dust...
      demurragedRow(PLAYER, 103n * CRC, 155n * CRC), // ...103 CRC wrapped
    ];
    await call();
    expect(batch()).toEqual([
      { fn: "unwrap", to: getAddress(WRAPPER) },
      { fn: "groupMint", to: HUB },
      { fn: "wrap", to: HUB },
      { fn: "approve", to: TOKEN },
      { fn: "join", to: ESCROW },
    ]);
    // Demurraged wrapper unwraps 1:1, so we free exactly (wrapAmount - dust),
    // and the mint draws both sources from the player's avatar in one entry.
    expect(unwrapAmount(sent[0][0])).toBe(STAKE - DUST);
    expect(groupMintArgs(sent[0][1])).toEqual({
      collateral: [getAddress(PLAYER)],
      amounts: [STAKE],
    });
  });

  test("tokens of an avatar the group does NOT trust are ignored", async () => {
    held = 0n;
    const stranger = "0x000000000000000000000000000000000000dEaD";
    tokenRows = [
      erc1155Row(PLAYER, DUST),
      demurragedRow(stranger, 103n * CRC, 155n * CRC), // not accepted collateral
    ];
    let thrown: unknown;
    try {
      await call();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(NoCirclesError);
    expect((thrown as InstanceType<typeof NoCirclesError>).available).toBe(
      DUST,
    );
    expect(sent).toHaveLength(0);
  });

  test("no stake token and no usable collateral — throws NoCirclesError", async () => {
    held = 0n;
    tokenRows = [erc1155Row(PLAYER, DUST)]; // nothing but dust
    let thrown: unknown;
    try {
      await call();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(NoCirclesError);
    expect((thrown as InstanceType<typeof NoCirclesError>).available).toBe(
      DUST,
    );
    expect((thrown as InstanceType<typeof NoCirclesError>).required).toBe(
      STAKE,
    );
    expect(sent).toHaveLength(0);
  });
});

const GROUP_KEY = GROUP.toLowerCase();

describe("planLift", () => {
  test("demurraged wrapper covers the need exactly (1:1) and mints from its owner", () => {
    const plan = planLift(STAKE, GROUP_KEY, [
      {
        avatar: PLAYER,
        token: WRAPPER,
        inflationary: false,
        demurraged: 5n * CRC,
        staticAmount: 7n * CRC,
      },
    ]);
    expect(plan).toEqual({
      unwraps: [{ token: WRAPPER, amount: STAKE }],
      mintOwners: [PLAYER],
      mintAmounts: [STAKE],
    });
  });

  test("prefers demurraged, spilling the remainder onto an inflationary wrapper", () => {
    const D = "0xD000000000000000000000000000000000000000";
    const I = "0xi000000000000000000000000000000000000000";
    const need = 3n * CRC;
    const plan = planLift(need, GROUP_KEY, [
      {
        avatar: PLAYER,
        token: I,
        inflationary: true,
        demurraged: 10n * CRC,
        staticAmount: 15n * CRC,
      },
      {
        avatar: PLAYER,
        token: D,
        inflationary: false,
        demurraged: 2n * CRC,
        staticAmount: 3n * CRC,
      },
    ]);
    // Demurraged token drained first (2 CRC, exact), inflationary covers the last
    // 1 CRC sized up from its 15:10 static:demurraged ratio (+1 wei cushion).
    expect(plan?.unwraps[0]).toEqual({ token: D, amount: 2n * CRC });
    expect(plan?.unwraps[1]?.token).toBe(I);
    expect(plan?.unwraps[1]?.amount).toBeGreaterThanOrEqual((3n * CRC) / 2n); // ~1.5 CRC static
    // Both wrappers are the player's own — one aggregated mint entry.
    expect(plan?.mintOwners).toEqual([PLAYER]);
    expect(plan?.mintAmounts).toEqual([need]);
  });

  test("target group's own tokens are consumed without a mint, before others", () => {
    const plan = planLift(STAKE, GROUP_KEY, [
      {
        avatar: PLAYER,
        token: null,
        inflationary: false,
        demurraged: STAKE,
        staticAmount: STAKE,
      },
      {
        avatar: GROUP_KEY,
        token: null,
        inflationary: false,
        demurraged: STAKE / 2n,
        staticAmount: STAKE / 2n,
      },
    ]);
    // Half comes from the group's own ERC-1155 (free), only the rest is minted.
    expect(plan).toEqual({
      unwraps: [],
      mintOwners: [PLAYER],
      mintAmounts: [STAKE / 2n],
    });
  });

  test("returns null when the sources can't cover the need", () => {
    expect(
      planLift(STAKE, GROUP_KEY, [
        {
          avatar: PLAYER,
          token: WRAPPER,
          inflationary: false,
          demurraged: CRC / 2n,
          staticAmount: CRC,
        },
      ]),
    ).toBeNull();
  });

  test("returns an empty plan when nothing is needed", () => {
    expect(planLift(0n, GROUP_KEY, [])).toEqual({
      unwraps: [],
      mintOwners: [],
      mintAmounts: [],
    });
  });
});
