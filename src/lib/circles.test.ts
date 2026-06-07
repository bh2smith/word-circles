import { beforeEach, describe, expect, mock, test } from "bun:test";
import { decodeFunctionData, getAddress } from "viem";
import * as realContract from "./contract";
import { hubAbi, wrapperAbi } from "./contract";

// joinPvpGame decides whether to prepend a (groupMint + wrap) "lift" before the
// approve+join, unwrapping the player's wrapped personal CRC first when their
// un-wrapped balance is short, and throwing NoCirclesError only when even the
// wrapped balance can't cover the stake. We stub the on-chain *reads* of
// ./contract (spreading the real module so its encoders/ABIs stay intact for
// other test files — mock.module is global), the wallet (miniapp SDK), and the
// Circles RPC (global fetch), then assert the batch joinPvpGame submits.
//
// The decision inputs:
//   held       = getErc20Balance(token, player)   — s-gCRC the player already has
//   wrapAmount = staticToDemurrage(token, stake)  — demurraged collateral the mint needs
//   personal   = getPersonalCrcBalance(player)    — UN-WRAPPED personal CRC in the Hub
//   wrapped    = circles_getTokenBalances(player)  — the player's wrapped ERC-20 CRC
let held = 0n;
let wrapAmount = 0n;
let personal = 0n;
let tokenRows: Record<string, unknown>[] = [];
let sent: { to: string; data: string }[][] = [];

const GROUP = "0xC19BC204eb1c1D5B3FE500E5E5dfaBaB625F286c";
const TOKEN = "0xeeF7B1f06B092625228C835Dd5D5B14641D1e54A";
const PLAYER = "0x09c24767a7f9f7b1d021189b68f7a5aea3cee458"; // twalther
const ESCROW = "0x0000000000000000000000000000000000000E5C";
// twalther's own demurraged wrapper, holding his 103 CRC (from the bug report).
const WRAPPER = "0xa2713c354fdb82ceb9df0b03badf0c9c9cc5eb61";
const HUB = realContract.HUB_ADDRESS;
const APPROVE = "0xapprovedata";
const JOIN = "0xjoindata";

mock.module("@aboutcircles/miniapp-sdk", () => ({
  isMiniappMode: () => true,
  onWalletChange: () => {},
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
  getPersonalCrcBalance: async () => personal,
  getTokenAvatar: async () => GROUP,
  staticToDemurrage: async () => wrapAmount,
}));

const { joinPvpGame, NoCirclesError, planUnwraps } = await import("./circles");

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

beforeEach(() => {
  sent = [];
  tokenRows = [];
  held = 0n;
  wrapAmount = STAKE; // round-trips to ~the stake
  personal = 0n;
  // Stub the Circles RPC (circles_getTokenBalances) used by fetchWrappedPersonalCrc.
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

  test("holds enough un-wrapped CRC — lifts with [mint, wrap, approve, join]", async () => {
    held = 0n;
    personal = 100n * CRC; // plenty of un-wrapped ERC-1155 in the Hub
    await call();
    expect(batch()).toEqual([
      { fn: "groupMint", to: HUB },
      { fn: "wrap", to: HUB },
      { fn: "approve", to: TOKEN },
      { fn: "join", to: ESCROW },
    ]);
  });

  // Regression for the twalther report (0x09c2…e458): can't enter PvP in either
  // group, "not enough Circles to stake", despite confirmed 103 personal CRC.
  // His CRC sits in a demurraged ERC-20 wrapper; the un-wrapped Hub balance is
  // dust. We now unwrap exactly the shortfall first.
  test("wrapped-only CRC — unwraps the shortfall, then [unwrap, mint, wrap, approve, join]", async () => {
    held = 0n;
    personal = DUST; // un-wrapped Hub balance is dust...
    tokenRows = [demurragedRow(PLAYER, 103n * CRC, 155n * CRC)]; // ...103 CRC wrapped
    await call();
    expect(batch()).toEqual([
      { fn: "unwrap", to: getAddress(WRAPPER) },
      { fn: "groupMint", to: HUB },
      { fn: "wrap", to: HUB },
      { fn: "approve", to: TOKEN },
      { fn: "join", to: ESCROW },
    ]);
    // Demurraged wrapper unwraps 1:1, so we free exactly (wrapAmount - dust).
    expect(unwrapAmount(sent[0][0])).toBe(STAKE - DUST);
  });

  test("wrapped CRC owned by a DIFFERENT avatar is ignored", async () => {
    held = 0n;
    personal = DUST;
    // A wrapper the player merely holds but doesn't own — not their personal CRC,
    // can't be used as their collateral. The only personal source is the dust.
    tokenRows = [demurragedRow(GROUP, 103n * CRC, 155n * CRC)];
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

  test("no stake token and no personal CRC anywhere — throws NoCirclesError", async () => {
    held = 0n;
    personal = DUST;
    tokenRows = []; // nothing wrapped either
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

describe("planUnwraps", () => {
  test("demurraged wrapper covers the need exactly (1:1)", () => {
    const plan = planUnwraps(STAKE, [
      {
        token: WRAPPER,
        inflationary: false,
        demurraged: 5n * CRC,
        staticAmount: 7n * CRC,
      },
    ]);
    expect(plan).toEqual([{ token: WRAPPER, amount: STAKE }]);
  });

  test("prefers demurraged, spilling the remainder onto an inflationary wrapper", () => {
    const D = "0xD000000000000000000000000000000000000000";
    const I = "0xi000000000000000000000000000000000000000";
    const need = 3n * CRC;
    const plan = planUnwraps(need, [
      {
        token: I,
        inflationary: true,
        demurraged: 10n * CRC,
        staticAmount: 15n * CRC,
      },
      {
        token: D,
        inflationary: false,
        demurraged: 2n * CRC,
        staticAmount: 3n * CRC,
      },
    ]);
    // Demurraged token drained first (2 CRC, exact), inflationary covers the last
    // 1 CRC sized up from its 15:10 static:demurraged ratio (+1 wei cushion).
    expect(plan?.[0]).toEqual({ token: D, amount: 2n * CRC });
    expect(plan?.[1]?.token).toBe(I);
    expect(plan?.[1]?.amount).toBeGreaterThanOrEqual((3n * CRC) / 2n); // ~1.5 CRC static
  });

  test("returns null when the wrapped balances can't cover the need", () => {
    expect(
      planUnwraps(STAKE, [
        {
          token: WRAPPER,
          inflationary: false,
          demurraged: CRC / 2n,
          staticAmount: CRC,
        },
      ]),
    ).toBeNull();
  });

  test("returns an empty plan when nothing is needed", () => {
    expect(planUnwraps(0n, [])).toEqual([]);
  });
});
