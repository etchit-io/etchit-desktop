import { describe, expect, it } from "vitest";

import { fitDimensions } from "./imageProcessor";

describe("fitDimensions", () => {
  it("returns input dimensions when both sides are under max", () => {
    expect(fitDimensions(800, 600, 1920)).toEqual({ width: 800, height: 600 });
  });

  it("scales landscape images so the long side hits max", () => {
    expect(fitDimensions(4000, 3000, 1920)).toEqual({ width: 1920, height: 1440 });
  });

  it("scales portrait images so the long side hits max", () => {
    expect(fitDimensions(3000, 4000, 1920)).toEqual({ width: 1440, height: 1920 });
  });

  it("scales square images so each side equals max", () => {
    expect(fitDimensions(3000, 3000, 1920)).toEqual({ width: 1920, height: 1920 });
  });

  it("rounds to whole pixels", () => {
    const { width, height } = fitDimensions(3001, 2001, 1920);
    expect(Number.isInteger(width)).toBe(true);
    expect(Number.isInteger(height)).toBe(true);
  });

  it("never returns zero for non-zero input", () => {
    expect(fitDimensions(1, 1, 1920)).toEqual({ width: 1, height: 1 });
  });
});
