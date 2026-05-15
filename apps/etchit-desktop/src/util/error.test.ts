import { describe, expect, it } from "vitest";

import { formatErr } from "./error";

describe("formatErr", () => {
  it("passes strings through", () => {
    expect(formatErr("nope")).toBe("nope");
  });

  it("returns Error.message", () => {
    expect(formatErr(new Error("boom"))).toBe("boom");
  });

  it("extracts .message from EIP-1193 error shapes", () => {
    expect(formatErr({ code: 4001, message: "user rejected the request" })).toBe(
      "user rejected the request",
    );
  });

  it("falls back to .reason when no .message", () => {
    expect(formatErr({ reason: "transaction reverted" })).toBe("transaction reverted");
  });

  it("digs into .data.message (JSON-RPC nested shape)", () => {
    expect(formatErr({ code: -32000, data: { message: "exec reverted: bad nonce" } })).toBe(
      "exec reverted: bad nonce",
    );
  });

  it("falls back to a JSON dump for unknown object shapes", () => {
    expect(formatErr({ weird: true })).toBe('{"weird":true}');
  });

  it("handles primitives via String()", () => {
    expect(formatErr(42)).toBe("42");
    expect(formatErr(null)).toBe("null");
    expect(formatErr(undefined)).toBe("undefined");
  });
});
