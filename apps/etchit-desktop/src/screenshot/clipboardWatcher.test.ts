// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { fingerprintRgba } from "./clipboardWatcher";

describe("fingerprintRgba", () => {
  it("yields the same fingerprint for identical content", () => {
    const a = new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255]);
    const b = new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255]);
    expect(fingerprintRgba(a, 2, 1)).toBe(fingerprintRgba(b, 2, 1));
  });

  it("differs when a single pixel changes", () => {
    const a = new Uint8Array(64).fill(10);
    const b = new Uint8Array(64).fill(10);
    b[5] = 99;
    expect(fingerprintRgba(a, 4, 4)).not.toBe(fingerprintRgba(b, 4, 4));
  });

  it("differs on different dimensions even when bytes match", () => {
    const buf = new Uint8Array(16).fill(7);
    expect(fingerprintRgba(buf, 2, 2)).not.toBe(fingerprintRgba(buf, 4, 1));
  });

  it("differs on different lengths", () => {
    const a = new Uint8Array(8).fill(3);
    const b = new Uint8Array(16).fill(3);
    expect(fingerprintRgba(a, 1, 2)).not.toBe(fingerprintRgba(b, 1, 4));
  });

  it("handles buffers smaller than the tip window without throwing", () => {
    const small = new Uint8Array([1, 2, 3, 4]);
    const fp = fingerprintRgba(small, 1, 1);
    expect(fp).toContain("1x1");
    expect(fp).toContain(`.${small.length}.`);
  });

  it("handles an empty buffer", () => {
    const empty = new Uint8Array();
    expect(() => fingerprintRgba(empty, 0, 0)).not.toThrow();
  });
});
