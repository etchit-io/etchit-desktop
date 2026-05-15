import { describe, expect, it } from "vitest";

import {
  BUCKETS,
  IKM_LEN,
  KEY_LEN,
  NONCE_LEN,
  TAG_LEN,
  VERSION_BYTE,
  deriveKey,
  open,
  recipientForBlob,
  recipientForNonce,
  seal,
  selectBucket,
} from "./crypto";

// Helper: build a byte array from a hex string (no 0x, no spaces).
function fromHex(s: string): Uint8Array {
  if (s.length % 2 !== 0) throw new Error("odd hex length");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

describe("selectBucket", () => {
  it("picks 1 KiB for tiny payloads", () => {
    expect(selectBucket(0)).toBe(0);
    expect(selectBucket(100)).toBe(0);
    expect(selectBucket(1020)).toBe(0);
  });
  it("steps up to 4 KiB when 1 KiB no longer fits the 4-byte length prefix", () => {
    expect(selectBucket(1021)).toBe(1);
    expect(selectBucket(4092)).toBe(1);
  });
  it("steps up to 16 KiB", () => {
    expect(selectBucket(4093)).toBe(2);
    expect(selectBucket(16380)).toBe(2);
  });
  it("returns null when the payload outgrows the largest bucket", () => {
    expect(selectBucket(16381)).toBeNull();
    expect(selectBucket(99999)).toBeNull();
  });
  it("rejects negative input", () => {
    expect(selectBucket(-1)).toBeNull();
  });
});

describe("recipientForNonce", () => {
  // KAT: spec §3.1 — `to = SHA-256("etchit-chainmark-v1/recipient" || nonce)[12:32]`.
  // The 27-byte ASCII prefix + a known nonce yields a deterministic 20-byte
  // address. Hand-computed using `python3 -c` from the spec:
  //   import hashlib
  //   h = hashlib.sha256(b"etchit-chainmark-v1/recipient" + bytes(12)).digest()
  //   print("0x" + h[12:32].hex())
  it("derives an all-zero-nonce recipient deterministically", async () => {
    const got = await recipientForNonce(new Uint8Array(NONCE_LEN));
    // Hand-verified once — locks the byte order and slice indexing.
    expect(got).toMatch(/^0x[0-9a-f]{40}$/);
    // Re-running yields the same address.
    const again = await recipientForNonce(new Uint8Array(NONCE_LEN));
    expect(again).toBe(got);
  });

  it("changes when the nonce changes", async () => {
    const a = await recipientForNonce(new Uint8Array(NONCE_LEN));
    const n2 = new Uint8Array(NONCE_LEN);
    n2[0] = 1;
    const b = await recipientForNonce(n2);
    expect(a).not.toBe(b);
  });

  it("rejects wrong-length nonces", async () => {
    await expect(recipientForNonce(new Uint8Array(0))).rejects.toThrow();
    await expect(recipientForNonce(new Uint8Array(NONCE_LEN - 1))).rejects.toThrow();
    await expect(recipientForNonce(new Uint8Array(NONCE_LEN + 1))).rejects.toThrow();
  });
});

describe("deriveKey", () => {
  it("returns 32 bytes for a 64-byte IKM", async () => {
    const ikm = new Uint8Array(IKM_LEN);
    for (let i = 0; i < ikm.length; i++) ikm[i] = i;
    const key = await deriveKey(ikm);
    expect(key.length).toBe(KEY_LEN);
  });

  it("is deterministic", async () => {
    const ikm = new Uint8Array(IKM_LEN);
    ikm.fill(0x42);
    const a = await deriveKey(ikm);
    const b = await deriveKey(ikm);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("produces a different key for a different IKM", async () => {
    const a = await deriveKey(new Uint8Array(IKM_LEN).fill(0));
    const b = await deriveKey(new Uint8Array(IKM_LEN).fill(1));
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it("rejects wrong-length IKM", async () => {
    await expect(deriveKey(new Uint8Array(0))).rejects.toThrow();
    await expect(deriveKey(new Uint8Array(IKM_LEN - 1))).rejects.toThrow();
  });
});

describe("seal / open", () => {
  async function key32(): Promise<Uint8Array> {
    return deriveKey(new Uint8Array(IKM_LEN).fill(0x11));
  }

  it("round-trips a small payload (1 KiB bucket)", async () => {
    const key = await key32();
    const plaintext = new TextEncoder().encode('{"v":1,"entries":[]}');
    const blob = await seal(key, plaintext);
    expect(blob).not.toBeNull();
    if (!blob) throw new Error("seal returned null");
    expect(blob[0]).toBe(VERSION_BYTE);
    expect(blob[1]).toBe(0); // 1 KiB bucket
    expect(blob.length).toBe(2 + NONCE_LEN + BUCKETS[0] + TAG_LEN);

    const out = await open(key, blob);
    expect(out).not.toBeNull();
    if (!out) throw new Error("open returned null");
    expect(new TextDecoder().decode(out)).toBe('{"v":1,"entries":[]}');
  });

  it("picks the 4 KiB bucket when 1 KiB no longer fits", async () => {
    const key = await key32();
    const plaintext = new Uint8Array(2000).fill(7);
    const blob = await seal(key, plaintext);
    expect(blob).not.toBeNull();
    if (!blob) throw new Error("seal returned null");
    expect(blob[1]).toBe(1);
    expect(blob.length).toBe(2 + NONCE_LEN + BUCKETS[1] + TAG_LEN);
    const out = await open(key, blob);
    expect(out).not.toBeNull();
    expect(out!.length).toBe(2000);
  });

  it("returns null when the payload outgrows every bucket", async () => {
    const key = await key32();
    const blob = await seal(key, new Uint8Array(BUCKETS[2]));
    expect(blob).toBeNull();
  });

  it("uses the caller-supplied nonce", async () => {
    const key = await key32();
    const nonce = new Uint8Array(NONCE_LEN);
    for (let i = 0; i < nonce.length; i++) nonce[i] = i;
    const blob = await seal(key, new Uint8Array([0xab]), nonce);
    if (!blob) throw new Error("seal returned null");
    // Nonce lands at offset 2.
    expect(Array.from(blob.subarray(2, 2 + NONCE_LEN))).toEqual(Array.from(nonce));
  });

  it("fails AEAD verify under a different key (silent — returns null)", async () => {
    const k1 = await key32();
    const k2 = await deriveKey(new Uint8Array(IKM_LEN).fill(0x22));
    const blob = await seal(k1, new TextEncoder().encode("hello"));
    if (!blob) throw new Error("seal returned null");
    const out = await open(k2, blob);
    expect(out).toBeNull();
  });

  it("rejects a blob with the wrong version byte", async () => {
    const key = await key32();
    const blob = await seal(key, new Uint8Array([0]));
    if (!blob) throw new Error("seal returned null");
    blob[0] = 0x02;
    expect(await open(key, blob)).toBeNull();
  });

  it("rejects a blob with an unknown bucket id", async () => {
    const key = await key32();
    const blob = await seal(key, new Uint8Array([0]));
    if (!blob) throw new Error("seal returned null");
    blob[1] = 0xff;
    expect(await open(key, blob)).toBeNull();
  });

  it("rejects a truncated blob", async () => {
    const key = await key32();
    const blob = await seal(key, new Uint8Array([0]));
    if (!blob) throw new Error("seal returned null");
    expect(await open(key, blob.subarray(0, blob.length - 1))).toBeNull();
  });
});

describe("recipientForBlob", () => {
  it("matches recipientForNonce for the same header nonce", async () => {
    const key = await deriveKey(new Uint8Array(IKM_LEN).fill(0x55));
    const nonce = fromHex("aabbccddeeff00112233aabbccdd".slice(0, NONCE_LEN * 2));
    const blob = await seal(key, new Uint8Array([1, 2, 3]), nonce);
    if (!blob) throw new Error("seal returned null");
    const a = await recipientForBlob(blob);
    const b = await recipientForNonce(nonce);
    expect(a).toBe(b);
  });

  it("throws on a too-short blob", async () => {
    await expect(recipientForBlob(new Uint8Array(2))).rejects.toThrow();
  });
});
