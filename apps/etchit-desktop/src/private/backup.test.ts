import { describe, expect, it } from "vitest";

import { backupDecrypt, backupEncrypt } from "./backup";
import { generatePassphrase, passwordStrength } from "./passphrase";
import { BACKUP_MAGIC } from "./spec";

describe("backup", () => {
  // PBKDF2 600k is slow — bump per-test timeout.
  it("round-trips a payload under a password", async () => {
    const payload = new TextEncoder().encode('{"entries":[1,2,3]}');
    const enc = await backupEncrypt(payload, "correct horse battery staple");
    const back = await backupDecrypt(enc, "correct horse battery staple");
    expect(back).not.toBeNull();
    expect(new TextDecoder().decode(back!)).toBe('{"entries":[1,2,3]}');
  }, 30_000);

  it("returns null with the wrong password (silent — no error)", async () => {
    const payload = new TextEncoder().encode("secret");
    const enc = await backupEncrypt(payload, "right");
    const back = await backupDecrypt(enc, "wrong");
    expect(back).toBeNull();
  }, 30_000);

  it("starts with the magic header", async () => {
    const enc = await backupEncrypt(new Uint8Array([1]), "pw");
    const magicBytes = new TextEncoder().encode(BACKUP_MAGIC);
    expect(Array.from(enc.subarray(0, magicBytes.length))).toEqual(Array.from(magicBytes));
  }, 30_000);

  it("returns null on missing / wrong magic", async () => {
    const garbage = new Uint8Array(100);
    expect(await backupDecrypt(garbage, "pw")).toBeNull();
  }, 30_000);

  it("returns null on a truncated file", async () => {
    const enc = await backupEncrypt(new Uint8Array([1]), "pw");
    expect(await backupDecrypt(enc.slice(0, 10), "pw")).toBeNull();
  }, 30_000);

  it("produces a different cipher on every export (fresh salt+iv)", async () => {
    const a = await backupEncrypt(new Uint8Array([1]), "pw");
    const b = await backupEncrypt(new Uint8Array([1]), "pw");
    expect(Array.from(a)).not.toEqual(Array.from(b));
    // But both decrypt back to the original under the same password.
    const da = await backupDecrypt(a, "pw");
    const db = await backupDecrypt(b, "pw");
    expect(da).not.toBeNull();
    expect(db).not.toBeNull();
    expect(Array.from(da!)).toEqual([1]);
    expect(Array.from(db!)).toEqual([1]);
  }, 60_000);
});

describe("generatePassphrase", () => {
  it("emits 6 hyphen-separated lowercase BIP-39 words by default", () => {
    const p = generatePassphrase();
    const parts = p.split("-");
    expect(parts).toHaveLength(6);
    for (const w of parts) expect(w).toMatch(/^[a-z]+$/);
  });

  it("emits N words on request", () => {
    expect(generatePassphrase(4).split("-")).toHaveLength(4);
    expect(generatePassphrase(8).split("-")).toHaveLength(8);
  });

  it("varies between calls", () => {
    const a = generatePassphrase();
    const b = generatePassphrase();
    expect(a).not.toBe(b);
  });
});

describe("passwordStrength", () => {
  it("flags empty", () => {
    expect(passwordStrength("")).toEqual({ label: "", cls: "" });
  });
  it("flags too-short", () => {
    expect(passwordStrength("abc").cls).toBe("err");
  });
  it("flags OK-with-warn for short-but-OK", () => {
    expect(passwordStrength("abcdefgh").cls).toBe("warn");
  });
  it("flags strong for long", () => {
    expect(passwordStrength("a".repeat(13)).cls).toBe("ok");
  });
  it("flags strong for mixed-classes", () => {
    expect(passwordStrength("Aa1!xyz9").cls).toBe("ok");
  });
});
