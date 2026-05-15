// Wallet-mode preference. Two modes:
//
// * `internal` — paste-key flow. Wallet key in OS keychain;
//   `ant-ffi` signs and pays internally. Default until the user
//   explicitly opts into WalletConnect.
// * `external` — WalletConnect Modal Web (Reown AppKit). The user's
//   mobile/extension wallet signs every payment; etchit never touches
//   a private key.
//
// Persisted via localStorage so the choice survives a relaunch.

const STORAGE_KEY = "etchit.walletMode";

export type WalletMode = "internal" | "external";

/** Fired whenever `setWalletMode` lands a new value. The Wallet tab
 *  and any upload tab that branches on mode listens for this so the
 *  UI reacts immediately instead of waiting for a tab remount. */
export const WALLET_MODE_CHANGED_EVENT = "etchit:wallet-mode-changed";

export function loadWalletMode(): WalletMode {
  if (typeof localStorage === "undefined") return "internal";
  const v = localStorage.getItem(STORAGE_KEY);
  return v === "external" ? "external" : "internal";
}

export function setWalletMode(mode: WalletMode): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(STORAGE_KEY, mode);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(WALLET_MODE_CHANGED_EVENT, { detail: mode }));
  }
}
