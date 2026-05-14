import { describe, expect, it } from "vitest";

import { computePan, countWords, nextDoubleClickScale } from "./composer";
import type { ImageValue, SlotValue } from "./types";

const tinyImage: ImageValue = {
  dataUrl: "data:image/webp;base64,X",
  mimeType: "image/webp",
  sizeBytes: 1,
  width: 1,
  height: 1,
  originalSizeBytes: 1,
};

describe("countWords", () => {
  it("counts words across text and longtext slots", () => {
    const state: Record<string, SlotValue | null> = {
      title: { kind: "text", value: "Hello world" },
      body: { kind: "longtext", value: "one two three\n\nfour five" },
    };
    expect(countWords(state)).toBe(7);
  });

  it("ignores empty and whitespace-only slots", () => {
    const state: Record<string, SlotValue | null> = {
      title: { kind: "text", value: "" },
      lede: { kind: "text", value: "   " },
      body: { kind: "longtext", value: "one two" },
    };
    expect(countWords(state)).toBe(2);
  });

  it("ignores image slots", () => {
    const state: Record<string, SlotValue | null> = {
      title: { kind: "text", value: "ok" },
      hero: { kind: "image", image: tinyImage },
    };
    expect(countWords(state)).toBe(1);
  });

  it("treats null slot values as zero", () => {
    expect(countWords({ title: null, body: null })).toBe(0);
  });

  it("returns 0 for empty state", () => {
    expect(countWords({})).toBe(0);
  });

  it("collapses runs of whitespace when counting", () => {
    const state: Record<string, SlotValue | null> = {
      body: { kind: "longtext", value: "one\t\ttwo   three\n\nfour" },
    };
    expect(countWords(state)).toBe(4);
  });
});

describe("computePan", () => {
  it("returns the start position when the image exactly fits the frame", () => {
    const frame = { w: 800, h: 450 };
    const natural = { w: 800, h: 450 };
    expect(computePan(frame, natural, { x: 50, y: 50 }, 100, 100)).toEqual({ x: 50, y: 50 });
  });

  it("decreases X when the user drags right on a horizontally-overflowing image", () => {
    // Frame 800x450 (16:9), image natural 1600x900 — same aspect, no overflow.
    // Force horizontal overflow: image is wider than frame at same height.
    const frame = { w: 800, h: 450 };
    const natural = { w: 1600, h: 450 };
    // scale = max(800/1600, 450/450) = 1.0 → scaledW=1600, overflowX=800
    const result = computePan(frame, natural, { x: 50, y: 50 }, 400, 0);
    // dx=400, overflowX=800, dXpct = 400/800 * 100 = 50; newX = 50 - 50 = 0
    expect(result.x).toBe(0);
    expect(result.y).toBe(50);
  });

  it("increases Y when the user drags up on a vertically-overflowing image", () => {
    const frame = { w: 800, h: 450 };
    const natural = { w: 800, h: 900 };
    // scale = max(1, 0.5) = 1 → scaledH = 900, overflowY = 450
    const result = computePan(frame, natural, { x: 50, y: 50 }, 0, -225);
    // dy=-225, overflowY=450, dYpct = -50; newY = 50 - (-50) = 100
    expect(result.y).toBe(100);
    expect(result.x).toBe(50);
  });

  it("clamps the position into [0, 100] so over-dragging stays in range", () => {
    const frame = { w: 800, h: 450 };
    const natural = { w: 1600, h: 450 };
    expect(computePan(frame, natural, { x: 50, y: 50 }, 100000, 0).x).toBe(0);
    expect(computePan(frame, natural, { x: 50, y: 50 }, -100000, 0).x).toBe(100);
  });

  it("ignores drags on the axis with no overflow", () => {
    const frame = { w: 800, h: 450 };
    const natural = { w: 800, h: 450 };
    expect(computePan(frame, natural, { x: 50, y: 50 }, 100, 100)).toEqual({ x: 50, y: 50 });
  });
});

describe("nextDoubleClickScale", () => {
  it("cycles default → zoom-out → zoom-in → default", () => {
    expect(nextDoubleClickScale(1)).toBeCloseTo(0.7);
    expect(nextDoubleClickScale(0.7)).toBeCloseTo(1.3);
    expect(nextDoubleClickScale(1.3)).toBeCloseTo(1);
  });

  it("snaps to default from any scale outside the cycle", () => {
    expect(nextDoubleClickScale(1.5)).toBe(1);
    expect(nextDoubleClickScale(2.4)).toBe(1);
    expect(nextDoubleClickScale(0.5)).toBe(1);
  });

  it("treats near-equal values as cycle stops within a small tolerance", () => {
    expect(nextDoubleClickScale(0.699)).toBeCloseTo(1.3);
    expect(nextDoubleClickScale(1.301)).toBeCloseTo(1);
  });
});
