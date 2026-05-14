import { describe, expect, it } from "vitest";

import { normalizeSecretKey } from "./secretKey";

const REAL = "f4b86ae19e4b1e625ea2af9b15015340443988407f0ae56d28a1050e64ece167";

describe("normalizeSecretKey", () => {
  it("accepts 64-hex lowercase", () => {
    expect(normalizeSecretKey(REAL)).toBe(REAL);
  });

  it("accepts uppercase and lowercases the result", () => {
    expect(normalizeSecretKey(REAL.toUpperCase())).toBe(REAL);
  });

  it("accepts 0x prefix", () => {
    expect(normalizeSecretKey(`0x${REAL}`)).toBe(REAL);
  });

  it("accepts capital 0X prefix", () => {
    expect(normalizeSecretKey(`0X${REAL}`)).toBe(REAL);
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeSecretKey(`  ${REAL}  \n`)).toBe(REAL);
  });

  it("rejects short input", () => {
    expect(normalizeSecretKey(REAL.slice(0, 63))).toBeNull();
  });

  it("rejects long input", () => {
    expect(normalizeSecretKey(`${REAL}a`)).toBeNull();
  });

  it("rejects non-hex characters", () => {
    expect(normalizeSecretKey("z".repeat(64))).toBeNull();
  });

  it("rejects empty input", () => {
    expect(normalizeSecretKey("")).toBeNull();
  });
});
