// Chainmark sync setting — persisted per-device.
//
// Off by default. Requires WalletConnect mode (V1 doesn't ship the
// internal-mode raw-tx-broadcast path). The Settings → Advanced
// section is the only UI exposure; the upload tabs read the value
// post-etch to decide whether to push a chainmark.

const STORAGE_KEY = "etchit.chainmarkEnabled";

export const CHAINMARK_SETTING_CHANGED_EVENT = "etchit:chainmark-setting-changed";

export function loadChainmarkEnabled(): boolean {
  if (typeof localStorage === "undefined") return false;
  return localStorage.getItem(STORAGE_KEY) === "true";
}

export function setChainmarkEnabled(enabled: boolean): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(STORAGE_KEY, enabled ? "true" : "false");
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(CHAINMARK_SETTING_CHANGED_EVENT, { detail: enabled }),
    );
  }
}
