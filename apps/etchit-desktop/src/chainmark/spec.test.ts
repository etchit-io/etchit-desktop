import { describe, expect, it } from "vitest";

import { CHAINMARK_CHAIN_ID, SIGN_MESSAGE, SIGN_MESSAGE_SHA256 } from "./spec";

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  let s = "";
  for (const b of digest) s += b.toString(16).padStart(2, "0");
  return s;
}

describe("chainmark spec constants", () => {
  it("SIGN_MESSAGE byte count is stable", () => {
    // Locks the byte count against accidental whitespace drift. The
    // load-bearing contract is the SHA-256 below; this is a fast
    // first-line check that catches typo-class edits.
    const bytes = new TextEncoder().encode(SIGN_MESSAGE);
    expect(bytes.length).toBe(131);
  });

  it("SIGN_MESSAGE matches the spec's pinned SHA-256", async () => {
    const got = await sha256Hex(new TextEncoder().encode(SIGN_MESSAGE));
    expect(got).toBe(SIGN_MESSAGE_SHA256);
  });

  it("CHAINMARK_CHAIN_ID is Arbitrum One", () => {
    expect(CHAINMARK_CHAIN_ID).toBe(42161);
  });
});
