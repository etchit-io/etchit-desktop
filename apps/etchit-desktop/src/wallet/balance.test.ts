import { describe, expect, it } from "vitest";

import { formatToken, shortHexAddress } from "./balance";

describe("formatToken", () => {
  it("renders whole ANT", () => {
    expect(formatToken("1000000000000000000")).toBe("1");
  });
  it("renders sub-ANT amounts", () => {
    // 0.5 ANT = 5 * 10^17 atto
    expect(formatToken("500000000000000000")).toBe("0.5");
  });
  it("trims trailing zeros in the fractional part", () => {
    expect(formatToken("1500000000000000000")).toBe("1.5");
  });
  it("clamps to the requested number of decimal places", () => {
    // 1.23456789... ANT — keep 4 decimals
    expect(formatToken("1234567890000000000", 18, 4)).toBe("1.2345");
  });
  it("handles zero", () => {
    expect(formatToken("0")).toBe("0");
  });
  it("handles very small amounts that round to zero at the requested precision", () => {
    // 0.00001 ANT — under 4 decimal places, displays as 0.
    expect(formatToken("10000000000000", 18, 4)).toBe("0");
  });
  it("returns sentinel for non-numeric input", () => {
    expect(formatToken("0xabc")).toBe("—");
    expect(formatToken("")).toBe("—");
  });
  it("works for ETH-style decimals (still 18)", () => {
    // 0.01 ETH
    expect(formatToken("10000000000000000")).toBe("0.01");
  });
});

describe("shortHexAddress", () => {
  it("formats a 42-char address", () => {
    expect(shortHexAddress("0x1234567890123456789012345678901234567890")).toBe("0x1234…7890");
  });
  it("leaves short inputs unchanged", () => {
    expect(shortHexAddress("0xabc")).toBe("0xabc");
  });
});
