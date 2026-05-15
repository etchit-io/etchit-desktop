import { describe, expect, it } from "vitest";

import { decode, encode, SCHEMA_VERSION, type WireEntry } from "./payload";

const VALID_ADDR = "0".repeat(63) + "1";

function entry(overrides: Partial<WireEntry> = {}): WireEntry {
  return {
    kind: "public",
    addr: VALID_ADDR,
    title: "hello",
    ts: 1714572800,
    action: "add",
    ...overrides,
  };
}

describe("encode", () => {
  it("wraps entries with the schema version", () => {
    const s = encode([entry()]);
    const parsed = JSON.parse(s);
    expect(parsed.v).toBe(SCHEMA_VERSION);
    expect(Array.isArray(parsed.entries)).toBe(true);
    expect(parsed.entries).toHaveLength(1);
  });

  it("preserves field order kind/addr/title/ts/action", () => {
    const s = encode([entry()]);
    const obj = JSON.parse(s).entries[0];
    expect(Object.keys(obj)).toEqual(["kind", "addr", "title", "ts", "action"]);
  });

  it("throws on a programmer-error kind", () => {
    expect(() => encode([entry({ kind: "private" as never })])).toThrow();
  });

  it("throws on a programmer-error action", () => {
    expect(() => encode([entry({ action: "delete" as never })])).toThrow();
  });
});

describe("decode", () => {
  it("round-trips an encode", () => {
    const e = entry({ title: "round trip" });
    const back = decode(encode([e]));
    expect(back).toEqual([e]);
  });

  it("returns null for non-JSON input", () => {
    expect(decode("not json")).toBeNull();
    expect(decode("")).toBeNull();
    expect(decode("null")).toBeNull();
  });

  it("returns null for an envelope with the wrong schema version", () => {
    expect(decode(JSON.stringify({ v: 2, entries: [] }))).toBeNull();
  });

  it("returns null when entries isn't an array", () => {
    expect(decode(JSON.stringify({ v: 1, entries: "nope" }))).toBeNull();
  });

  it("silently skips entries with unknown kind", () => {
    const e1 = entry({ kind: "public" });
    const bad = { ...entry(), kind: "private" };
    const json = JSON.stringify({ v: 1, entries: [e1, bad] });
    expect(decode(json)).toEqual([e1]);
  });

  it("silently skips entries with unknown action", () => {
    const e1 = entry({ action: "add" });
    const bad = { ...entry(), action: "delete" };
    const json = JSON.stringify({ v: 1, entries: [e1, bad] });
    expect(decode(json)).toEqual([e1]);
  });

  it("silently skips entries with malformed addr", () => {
    const cases = [
      { ...entry(), addr: "" },
      { ...entry(), addr: "abc" },
      { ...entry(), addr: "z".repeat(64) },
      { ...entry(), addr: "F".repeat(64) }, // uppercase rejected
    ];
    for (const bad of cases) {
      const json = JSON.stringify({ v: 1, entries: [bad] });
      expect(decode(json)).toEqual([]);
    }
  });

  it("silently skips entries with oversize title (>256 UTF-8 bytes)", () => {
    const tooLong = { ...entry(), title: "a".repeat(257) };
    const json = JSON.stringify({ v: 1, entries: [tooLong] });
    expect(decode(json)).toEqual([]);
    // Exactly 256 bytes is fine.
    const ok = { ...entry(), title: "a".repeat(256) };
    expect(decode(JSON.stringify({ v: 1, entries: [ok] }))).toEqual([ok]);
  });

  it("ignores unknown top-level fields", () => {
    const json = JSON.stringify({ v: 1, entries: [entry()], something: "future" });
    expect(decode(json)).toEqual([entry()]);
  });

  it("ignores unknown entry fields", () => {
    const e = { ...entry(), surplus: "ignored", more: 42 };
    const json = JSON.stringify({ v: 1, entries: [e] });
    expect(decode(json)).toEqual([entry()]);
  });

  it("rejects entries with non-string title", () => {
    const bad = { ...entry(), title: 123 };
    expect(decode(JSON.stringify({ v: 1, entries: [bad] }))).toEqual([]);
  });

  it("rejects entries with non-numeric ts", () => {
    const bad = { ...entry(), ts: "1714572800" };
    expect(decode(JSON.stringify({ v: 1, entries: [bad] }))).toEqual([]);
  });
});
