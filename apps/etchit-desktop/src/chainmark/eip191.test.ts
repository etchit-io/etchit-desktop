// Cross-client EIP-191 sanity check.
//
// The chainmark spec §4 requires every implementation (Android,
// desktop internal mode, JS frontends) to produce byte-identical
// `personal_sign` signatures for the same `(key, message)` pair.
// `ethers.js` is the de-facto reference for EIP-191 in the JS world;
// pinning the Rust signer's expected output against an ethers.js
// computation locks down "Rust produces what JS expects". When
// AppKit/WalletConnect signs in external mode it follows the same
// EIP-191 rules, so the same signature emerges there too.
//
// Run-time vector — computed once, used as the fixed golden for the
// Rust side test (`src-tauri/src/chainmark.rs` :: matches_eip191_vector).

import { describe, expect, it } from "vitest";
import { Wallet } from "ethers";

const TEST_KEY = "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";
const TEST_MSG = "hello";

describe("EIP-191 cross-client vector", () => {
  it("ethers.Wallet.signMessage produces the pinned signature for the Rust test", async () => {
    const w = new Wallet(TEST_KEY);
    const sig = await w.signMessage(TEST_MSG);
    // Pinned: the same hex appears in `chainmark.rs :: EXPECTED_SIG`.
    // If you update either side, update both.
    expect(sig).toBe(
      "0xa5d58782075bdf09490159d634d1aae66a8f6777c7247d2f233e9511cfd7c64c34f288cdbcea5370e4863fdbe9f4d86654c2ba1d86589e9ebb64494c649008591b",
    );
  });
});
