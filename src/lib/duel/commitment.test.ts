import { describe, expect, test } from "bun:test";
import { commitWord } from "./commitment";

describe("commitWord", () => {
  // Cross-checks against values produced by the Noir circuit / committed fixtures.
  test("matches the M2 verifier fixture commitment", async () => {
    const c = await commitWord("react", 123456789n, 0x1234567890abcdefn);
    expect(c).toBe(
      "0x1980814b693a2d688f0c6fa7be8daf0c1a05a5d0e5f611d32cf6eb3ef0aed922",
    );
  });

  test("matches the M3 duel solve-proof commitment (bound to matchId(alice,1))", async () => {
    const matchId =
      0x0203dd68657862fa26bd7c4a12a3a2b3bbf2220be739d51860c5d12e036c38ecn;
    const c = await commitWord("react", 123456789n, matchId);
    expect(c).toBe(
      "0x00e01c0d6dcd5ce90b995ed425047e7afc52d67ef532bfe6c2c67bb9902397bb",
    );
  });

  test("binding changes the commitment (no cross-match reuse)", async () => {
    const a = await commitWord("react", 123456789n, 1n);
    const b = await commitWord("react", 123456789n, 2n);
    expect(a).not.toBe(b);
  });
});
