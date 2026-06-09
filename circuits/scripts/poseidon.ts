/**
 * Poseidon2 helper that matches the Noir `poseidon` lib (v0.3.0) used by the
 * circuit. bb.js's `poseidon2Hash` is the same bn254 Poseidon2 sponge, so a
 * tree built here is consistent with `Poseidon2::hash` in main.nr.
 *
 * A field element is a 32-byte big-endian buffer. We avoid bb.js's internal
 * `Fr` (not exported from the package root) and build buffers directly.
 */
import { BarretenbergSync } from "@aztec/bb.js";

let api: BarretenbergSync | undefined;

export async function initPoseidon(): Promise<void> {
  api = await BarretenbergSync.new();
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

export function toHex(buf: Uint8Array): string {
  return "0x" + Buffer.from(buf).toString("hex");
}

/** Poseidon2 hash of field-buffer inputs -> 32-byte big-endian buffer. */
export function poseidon2(inputs: Uint8Array[]): Uint8Array {
  if (!api) throw new Error("call initPoseidon() first");
  return api.poseidon2Hash({ inputs }).hash;
}

/** Convenience: Poseidon2 over bigints. */
export function poseidon2n(inputs: bigint[]): bigint {
  return fromField(poseidon2(inputs.map(toField)));
}
