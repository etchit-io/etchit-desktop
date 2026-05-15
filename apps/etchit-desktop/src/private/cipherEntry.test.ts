import { describe, expect, it } from "vitest";

import { decryptDataMap, encryptDataMap } from "./cipherEntry";

function key32(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

describe("cipherEntry", () => {
  it("round-trips a data-map hex string", async () => {
    const k = key32(0x11);
    const dm = "deadbeefcafe" + "00".repeat(50);
    const cipher = await encryptDataMap(k, dm);
    const back = await decryptDataMap(k, cipher);
    expect(back).toBe(dm);
  });

  it("rejects a different key (returns null silently)", async () => {
    const k1 = key32(0x11);
    const k2 = key32(0x22);
    const cipher = await encryptDataMap(k1, "abcd");
    const back = await decryptDataMap(k2, cipher);
    expect(back).toBeNull();
  });

  it("produces a different cipher for the same plaintext (fresh IV)", async () => {
    const k = key32(0x33);
    const a = await encryptDataMap(k, "abcd");
    const b = await encryptDataMap(k, "abcd");
    expect(a).not.toBe(b);
  });

  it("rejects garbage cipher input", async () => {
    const k = key32(0x44);
    expect(await decryptDataMap(k, "not hex")).toBeNull();
    expect(await decryptDataMap(k, "")).toBeNull();
    expect(await decryptDataMap(k, "ab")).toBeNull(); // too short
  });
});
