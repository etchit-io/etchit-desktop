import { describe, expect, it } from "vitest";

import { kindLabel, relativeTime, shortAddress } from "./format";

describe("relativeTime", () => {
  const now = 1_700_000_000_000;
  it("returns 'just now' for very recent times", () => {
    expect(relativeTime(now - 5_000, now)).toBe("just now");
    expect(relativeTime(now - 44_000, now)).toBe("just now");
  });
  it("formats minutes", () => {
    expect(relativeTime(now - 60_000, now)).toBe("1m ago");
    expect(relativeTime(now - 59 * 60_000, now)).toBe("59m ago");
  });
  it("formats hours", () => {
    expect(relativeTime(now - 60 * 60_000, now)).toBe("1h ago");
    expect(relativeTime(now - 23 * 60 * 60_000, now)).toBe("23h ago");
  });
  it("formats days under a week", () => {
    expect(relativeTime(now - 24 * 60 * 60_000, now)).toBe("1d ago");
    expect(relativeTime(now - 6 * 24 * 60 * 60_000, now)).toBe("6d ago");
  });
  it("falls back to an ISO date for anything older", () => {
    const old = now - 30 * 24 * 60 * 60_000;
    const out = relativeTime(old, now);
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it("clamps future timestamps to 'just now'", () => {
    expect(relativeTime(now + 10_000, now)).toBe("just now");
  });
});

describe("shortAddress", () => {
  it("returns prefix…suffix for a 64-hex address", () => {
    const addr = "a".repeat(60) + "beef";
    expect(shortAddress(addr)).toBe("aaaaaa…beef");
  });
  it("leaves short inputs unchanged", () => {
    expect(shortAddress("abc")).toBe("abc");
    expect(shortAddress("abcdef0123")).toBe("abcdef0123");
  });
});

describe("kindLabel", () => {
  it("maps known kinds", () => {
    expect(kindLabel("text")).toBe("Text");
    expect(kindLabel("file")).toBe("File");
    expect(kindLabel("blog")).toBe("Blog");
    expect(kindLabel("site")).toBe("Site");
  });
  it("passes through unknown kinds verbatim", () => {
    expect(kindLabel("future-kind")).toBe("future-kind");
  });
});
