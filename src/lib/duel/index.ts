/**
 * ZK Wordle duel client SDK. See docs/zk-duel-protocol.md.
 *
 * Pure helpers (encoding, ABI) are re-exported here. The proving modules
 * (`./prove`, `./tree`, `./commitment`, `./poseidon`) pull in bb.js/WASM — import
 * them directly and lazily from client code, e.g.
 *   const { generateFeedbackProof } = await import("@/lib/duel/prove");
 */
export * from "./encoding";
export * from "./abi";
