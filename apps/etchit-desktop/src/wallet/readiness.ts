// SPDX-License-Identifier: AGPL-3.0-only
// "Is the active wallet ready to pay for an etch?" check.
//
// Used by the upload tabs to gate the Etch button. Without this, an
// Internal-mode user with no key set can spend 5 minutes composing
// and only learn at click-time that their wallet isn't set up — by
// which point the only signal is a Rust backend error.
//
// External mode reports `true` unconditionally: clicking Etch from a
// disconnected external wallet pops the WalletConnect modal, which
// IS the readiness path. We don't want to block the button there.

import { invoke } from "@tauri-apps/api/core";

import { loadWalletMode, WALLET_MODE_CHANGED_EVENT } from "./mode";
import { KEYCHAIN_CHANGED_EVENT } from "./statusPill";

/** Snapshot of wallet readiness. `false` means: trying to etch right
 *  now will dead-end. */
export async function isWalletReady(): Promise<boolean> {
  if (loadWalletMode() === "internal") {
    try {
      return await invoke<boolean>("has_secret_key");
    } catch {
      return false;
    }
  }
  // External: WalletConnect handles its own connect prompt on click.
  return true;
}

/** Reason text for a not-ready state, for showing under a disabled
 *  Etch button. Returns `null` when ready. */
export async function notReadyReason(): Promise<string | null> {
  if (await isWalletReady()) return null;
  if (loadWalletMode() === "internal") {
    return "Internal wallet has no key — set one in Settings → Advanced, or switch to WalletConnect.";
  }
  return null;
}

/** Subscribe to readiness changes (mode flip, key store/clear).
 *  Handler is called with the new readiness state. Returns the
 *  unsubscribe function. */
export function onReadinessChange(handler: (ready: boolean) => void): () => void {
  const refresh = (): void => {
    void isWalletReady().then(handler);
  };
  window.addEventListener(WALLET_MODE_CHANGED_EVENT, refresh);
  window.addEventListener(KEYCHAIN_CHANGED_EVENT, refresh);
  return () => {
    window.removeEventListener(WALLET_MODE_CHANGED_EVENT, refresh);
    window.removeEventListener(KEYCHAIN_CHANGED_EVENT, refresh);
  };
}
