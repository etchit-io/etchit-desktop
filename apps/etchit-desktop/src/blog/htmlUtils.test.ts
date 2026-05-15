import { describe, expect, it } from "vitest";

import { isSafeUrl, normaliseUrl } from "./htmlUtils";

describe("normaliseUrl", () => {
  it("returns empty for empty input", () => {
    expect(normaliseUrl("")).toBe("");
    expect(normaliseUrl("   ")).toBe("");
  });

  it("passes through https and http unchanged", () => {
    expect(normaliseUrl("https://example.com")).toBe("https://example.com");
    expect(normaliseUrl("http://example.com")).toBe("http://example.com");
  });

  it("passes through mailto, autonomi, tel unchanged", () => {
    expect(normaliseUrl("mailto:jo@example.com")).toBe("mailto:jo@example.com");
    expect(normaliseUrl("autonomi://abc")).toBe("autonomi://abc");
    expect(normaliseUrl("tel:+1234567890")).toBe("tel:+1234567890");
  });

  it("returns empty for bare domains — fetch>it can't reach the clearnet, so we don't invent https links", () => {
    expect(normaliseUrl("example.com")).toBe("");
    expect(normaliseUrl("twitter.com/me")).toBe("");
  });

  it("turns 64-hex into an autonomi:// link", () => {
    const addr = "a".repeat(64);
    expect(normaliseUrl(addr)).toBe(`autonomi://${addr}`);
    expect(normaliseUrl(addr.toUpperCase())).toBe(`autonomi://${addr}`);
  });

  it("turns bare emails into mailto: links", () => {
    expect(normaliseUrl("jo@example.com")).toBe("mailto:jo@example.com");
  });

  it("returns empty for protocol-relative URLs (no clearnet from fetch>it)", () => {
    expect(normaliseUrl("//cdn.example.com/x.js")).toBe("");
  });

  it("returns empty for dangerous schemes", () => {
    expect(normaliseUrl("javascript:alert(1)")).toBe("");
    expect(normaliseUrl("JAVASCRIPT:alert(1)")).toBe("");
    expect(normaliseUrl("data:text/html,<script>")).toBe("");
    expect(normaliseUrl("vbscript:x")).toBe("");
    expect(normaliseUrl("file:///etc/passwd")).toBe("");
    expect(normaliseUrl("blob:x")).toBe("");
  });

  it("trims whitespace before scheme detection", () => {
    expect(normaliseUrl("  https://example.com  ")).toBe("https://example.com");
    expect(normaliseUrl("  jo@example.com  ")).toBe("mailto:jo@example.com");
  });
});

describe("isSafeUrl", () => {
  it("accepts the publishable schemes", () => {
    expect(isSafeUrl("https://x")).toBe(true);
    expect(isSafeUrl("http://x")).toBe(true);
    expect(isSafeUrl("mailto:x")).toBe(true);
    expect(isSafeUrl("autonomi://x")).toBe(true);
    expect(isSafeUrl("tel:x")).toBe(true);
  });

  it("rejects dangerous schemes and bare strings", () => {
    expect(isSafeUrl("javascript:x")).toBe(false);
    expect(isSafeUrl("data:x")).toBe(false);
    expect(isSafeUrl("example.com")).toBe(false);
    expect(isSafeUrl("")).toBe(false);
  });
});
