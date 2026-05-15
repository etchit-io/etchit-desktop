// Fire-and-forget chainmark sync entry point. Wired into the upload
// tabs' success callbacks — every successful public etch in
// WalletConnect mode optionally fans out a chainmark tx.
//
// Gating:
//   1. User toggled "Sync this device's etches to chain" in
//      Settings → Advanced.
//   2. Wallet mode is External (WalletConnect). Internal mode falls
//      out — V1 doesn't ship the internal-mode broadcast path.
//   3. A wallet session is currently connected. If not, we silently
//      skip (no point waking the modal just to push a sync).
//
// Errors only log; they don't reverse the etch that already landed.

import { currentAccount, currentProvider } from "../wallet/appkit";
import { loadWalletMode } from "../wallet/mode";

import type { WireAction } from "./payload";
import { pushChainmark } from "./sender";
import { loadChainmarkEnabled } from "./settings";

/** Optional — caller passes `null` to fall back to "Untitled". */
export function pushChainmarkBestEffort(
  addr: string,
  title: string | null,
  action: WireAction,
): void {
  if (!loadChainmarkEnabled()) return;
  if (loadWalletMode() !== "external") return;

  // Address must be a valid 64-hex xor-name; private-only entries
  // (where the "address" is the local entry id) shouldn't ever pass
  // this guard since the Private Etch tab doesn't push chainmarks.
  if (!/^[0-9a-f]{64}$/i.test(addr)) return;

  void (async () => {
    try {
      const account = await currentAccount();
      const provider = await currentProvider();
      if (!account || !provider) return;
      await pushChainmark(account, provider, {
        addr: addr.toLowerCase(),
        title: (title ?? "").slice(0, 256),
        action,
      });
    } catch (e: unknown) {
      // Surface to the diagnostic channel so it shows up in
      // `[chainmark]` lines without disturbing the etch result UI.
      // eslint-disable-next-line no-console
      console.warn("[chainmark] sync failed:", e);
    }
  })();
}
