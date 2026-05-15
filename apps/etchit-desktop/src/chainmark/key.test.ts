import { beforeEach, describe, expect, it } from "vitest";

import { clearCachedKey, loadCachedKey, saveCachedKey } from "./key";

describe("chainmark key cache", () => {
  const WALLET = "0xAbCdEF0000000000000000000000000000000001";

  beforeEach(() => localStorage.clear());

  it("returns null when nothing is cached", () => {
    expect(loadCachedKey(WALLET)).toBeNull();
  });

  it("round-trips a 32-byte key", () => {
    const key = new Uint8Array(32);
    for (let i = 0; i < key.length; i++) key[i] = i + 1;
    saveCachedKey(WALLET, key);
    const back = loadCachedKey(WALLET);
    expect(back).not.toBeNull();
    expect(Array.from(back!)).toEqual(Array.from(key));
  });

  it("is keyed by lowercase address", () => {
    const key = new Uint8Array(32).fill(7);
    saveCachedKey(WALLET, key);
    expect(loadCachedKey(WALLET.toUpperCase())).not.toBeNull();
    expect(loadCachedKey(WALLET.toLowerCase())).not.toBeNull();
  });

  it("clears on demand", () => {
    saveCachedKey(WALLET, new Uint8Array(32).fill(9));
    clearCachedKey(WALLET);
    expect(loadCachedKey(WALLET)).toBeNull();
  });

  it("scopes per wallet", () => {
    const w1 = "0x0000000000000000000000000000000000000001";
    const w2 = "0x0000000000000000000000000000000000000002";
    saveCachedKey(w1, new Uint8Array(32).fill(1));
    saveCachedKey(w2, new Uint8Array(32).fill(2));
    expect(loadCachedKey(w1)![0]).toBe(1);
    expect(loadCachedKey(w2)![0]).toBe(2);
  });
});
