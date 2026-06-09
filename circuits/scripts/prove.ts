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

// Mirrors wordle_feedback/Prover.toml.
const inputs = {
  secret: ["17", "4", "0", "2", "19"], // "react" (private)
  salt: "123456789",
  commitment:
    "0x1f7a0ec0831a06e6c5a30f6ec2ae1d99b3bea5634321c2450e712f98514713ca",
  guess: ["2", "17", "0", "13", "4"], // "crane" (public)
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
