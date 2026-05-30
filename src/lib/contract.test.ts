import { describe, expect, test } from "bun:test";
import { decodeFunctionData } from "viem";
import {
  encodeApprove,
  encodeGroupMint,
  encodeWrap,
  hubAbi,
  erc20Abi,
} from "./contract";

// These selectors were verified on-chain against the Circles v2 Hub on Gnosis
// (cast sig). Pinning them guards against an ABI typo silently changing the
// calldata the miniapp batch submits.
const GROUP_MINT_SELECTOR = "0x6cb498e5";
const WRAP_SELECTOR = "0xaabd6954";

const GROUP = "0xC19BC204eb1c1D5B3FE500E5E5dfaBaB625F286c";
const PLAYER = "0x0902c5866FBf7B30A4A2E26D37a97097eefe8243";
const TOKEN = "0xeeF7B1f06B092625228C835Dd5D5B14641D1e54A";

describe("encodeGroupMint", () => {
  test("uses the on-chain groupMint selector", () => {
    const data = encodeGroupMint(GROUP, [PLAYER], [123n]);
    expect(data.slice(0, 10)).toBe(GROUP_MINT_SELECTOR);
  });

  test("round-trips group, collateral, amounts and empty data", () => {
    const data = encodeGroupMint(GROUP, [PLAYER], [123n]);
    const { functionName, args } = decodeFunctionData({ abi: hubAbi, data });
    expect(functionName).toBe("groupMint");
    expect(args).toEqual([
      GROUP,
      [PLAYER],
      [123n],
      "0x",
    ] as unknown as typeof args);
  });
});

describe("encodeWrap", () => {
  test("uses the on-chain wrap selector", () => {
    const data = encodeWrap(GROUP, 123n);
    expect(data.slice(0, 10)).toBe(WRAP_SELECTOR);
  });

  test("always wraps as inflationary (type 1)", () => {
    const data = encodeWrap(GROUP, 123n);
    const { functionName, args } = decodeFunctionData({ abi: hubAbi, data });
    expect(functionName).toBe("wrap");
    expect(args).toEqual([GROUP, 123n, 1] as unknown as typeof args);
  });
});

describe("encodeApprove", () => {
  test("approves the escrow to spend the stake token", () => {
    const data = encodeApprove(TOKEN, 1000n);
    const { functionName, args } = decodeFunctionData({ abi: erc20Abi, data });
    expect(functionName).toBe("approve");
    expect(args).toEqual([TOKEN, 1000n] as unknown as typeof args);
  });
});
