/**
 * Spike proving harness: the browser/mobile proving path, run in Node.
 *
 * Executes the witness with noir_js, then proves with bb.js (UltraHonk, the
 * `keccakZK` / EVM target — same as the native `bb prove -t evm`). Proving runs
 * single-threaded by default (BB_THREADS=1) as a conservative proxy for mobile
 * WASM. Set BB_THREADS=0 to let bb.js pick (multi-threaded) for comparison.
 *
 *   bun run scripts/prove.ts            # single-thread (mobile proxy)
 *   BB_THREADS=0 bun run scripts/prove.ts
 *
 * Inputs are the same as wordle_feedback/Prover.toml (secret "react",
 * guess "crane" -> feedback 293). The harness's job is to TIME proving, so it
 * reuses the precomputed commitment rather than re-deriving Poseidon in JS.
 */
import { Noir } from "@noir-lang/noir_js";
import { Barretenberg, UltraHonkBackend } from "@aztec/bb.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const circuit = JSON.parse(
  readFileSync(join(here, "../target/wordle_feedback.json"), "utf8"),
);

// Mirrors wordle_feedback/Prover.toml (secret "react", guess "crane").
const inputs = {
  secret: ["17", "4", "0", "2", "19"], // "react" (private)
  salt: "123456789",
  leaf_index: "1551",
  commitment:
    "0x1f7a0ec0831a06e6c5a30f6ec2ae1d99b3bea5634321c2450e712f98514713ca",
  dictionary_root:
    "0x0984b03ac65fe9e4710ce7fb30f53d292b0d03f812b247ef32764d6018655f87",
  guess: ["2", "17", "0", "13", "4"], // "crane" (public)
  merkle_path: [
    "0x045bd9ed3ac414de0d5fac24eb9b9c7fbee04989a18709d7685ba8e5c5b936e0",
    "0x19e04053a5d447fe2a0dfa778cd902dd355e2392b83b5fd7952b986d414ca7a0",
    "0x2b78a6bcdc68cf0a3b5f3b607be96927d81d4109500cd54d1c0ab47b80d25f83",
    "0x053ef0fdb4111cbf733469814de278e2c7816e905615bf3b639611cf4cf9d149",
    "0x2a04b3a24e9af138064e1630c91e9481a09d10e719eb9760defd82aec29ecaf2",
    "0x0506a795dd5d819a37eb05d0868e50f3f6a0253b771b9549b4ef3c5db15b13c3",
    "0x1669a20353f0501600beee0d17dc87d56f13a6c8a634e7262bd831b7b27a5d35",
    "0x1b20a170777fb18bc22dea8c05b453c2d19763097fe9d890cd120c6c75acb1b4",
    "0x09edc957d5a2fd79a3924a1e4843314211dc3f1929f73f2dead2756a7cdfac50",
    "0x020a825390af1ce1faf69ca0c853472ea5f5381c720c739907c93cf99e8f4d33",
    "0x0f105f1934d2274e6b0309e9eb601c2b027883e8119b8a1e31fbe4593f92a8f8",
    "0x19b6aa7756aef2920b328ec711d5f70387119a6c19dea97aea24b5b1a0f50286",
  ],
};

const THREADS = Number(process.env.BB_THREADS ?? "1");
const ms = (a: number, b: number) => `${(b - a).toFixed(0)} ms`;

const noir = new Noir(circuit);
const tStart = performance.now();
const { witness, returnValue } = await noir.execute(inputs);
const tExec = performance.now();

const api = await Barretenberg.new({ threads: THREADS });
const backend = new UltraHonkBackend(circuit.bytecode, api);

const tBackend = performance.now();
const proof = await backend.generateProof(witness, { keccakZK: true });
const tProve = performance.now();

const ok = await backend.verifyProof(proof, { keccakZK: true });
const tVerify = performance.now();

console.log("=== ZK Wordle duel — proving harness ===");
console.log(`threads:            ${THREADS === 0 ? "auto (multi)" : THREADS}`);
console.log(`feedback (return):  ${returnValue}  (expected 0x125 = 293)`);
console.log(`proof size:         ${proof.proof.length} bytes`);
console.log(`public inputs:      ${proof.publicInputs.length}`);
console.log(`verified:           ${ok}`);
console.log("--- timings ---");
console.log(`witness execute:    ${ms(tStart, tExec)}`);
console.log(`backend init:       ${ms(tExec, tBackend)}`);
console.log(
  `generateProof:      ${ms(tBackend, tProve)}   <-- mobile-proxy metric`,
);
console.log(`verifyProof:        ${ms(tProve, tVerify)}`);

await api.destroy();
if (!ok) process.exit(1);
