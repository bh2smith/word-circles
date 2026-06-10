/**
 * Poseidon2 matching the Noir `poseidon` lib used by the circuit (bb.js's
 * Poseidon2 is byte-identical — verified in tests against the known commitment).
 *
 * Runtime module (pulls in @aztec/bb.js / WASM). Import lazily from client code;
 * do not import from a Server Component or a module loaded during SSR.
 */
import { BarretenbergSync } from "@aztec/bb.js";

let api: BarretenbergSync | undefined;

async function getApi(): Promise<BarretenbergSync> {
  if (!api) api = await BarretenbergSync.new();
  return api;
}

/** bigint -> 32-byte big-endian field buffer. */
export function toField(n: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = n;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** 32-byte big-endian buffer -> bigint. */
export function fromField(buf: Uint8Array): bigint {
  let v = 0n;
  for (const b of buf) v = (v << 8n) | BigInt(b);
  return v;
}

export function toHex32(n: bigint): `0x${string}` {
  return `0x${n.toString(16).padStart(64, "0")}`;
}

/** Poseidon2 over a list of field bigints -> field bigint. */
export async function poseidon2(inputs: bigint[]): Promise<bigint> {
  const bb = await getApi();
  const { hash } = bb.poseidon2Hash({ inputs: inputs.map(toField) });
  return fromField(hash);
}
