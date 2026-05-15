// Top-bar wallet status pill. Always-visible answer to "which wallet
// pays when I click Etch?". Reflects the active wallet mode (internal
// vs WalletConnect) and the address that will sign. Clicking the pill
// jumps to the Wallet tab so the user can switch or connect.
//
// State sources:
//
//   * `mode` from `wallet/mode.ts` (persisted in localStorage)
//   * for `internal`: address derived in Rust via `internal_wallet_info`
//     — kept locally cached, refreshed on relevant events
//   * for `external`: address read from AppKit, kept live via the
//     account-change subscription

import { invoke } from "@tauri-apps/api/core";

import { currentAccount, onAccountChange } from "./appkit";
import { shortHexAddress } from "./balance";
import {
  loadWalletMode,
  WALLET_MODE_CHANGED_EVENT,
  type WalletMode,
} from "./mode";

interface InternalInfo {
  address: string;
  ant_atto: string;
  eth_wei: string;
}

/** Fired by the rest of the app when the keychain key changes (set /
 *  cleared from Settings → Advanced). The pill listens to refresh the
 *  cached internal address without waiting for a Wallet-tab visit. */
export const KEYCHAIN_CHANGED_EVENT = "etchit:keychain-changed";

let internalAddress: string | null = null;
let externalAddress: string | null = null;
let activeMode: WalletMode = "internal";

export function mountWalletPill(host: HTMLElement): void {
  host.innerHTML = "";
  host.classList.add("wallet-pill");
  host.setAttribute("role", "button");
  host.setAttribute("tabindex", "0");
  host.addEventListener("click", () => goToWalletTab());
  host.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      goToWalletTab();
    }
  });

  const paint = (): void => render(host);

  activeMode = loadWalletMode();
  paint();
  void refreshInternal().then(paint);
  void refreshExternal().then(paint);
  void subscribeToExternalChanges(paint);

  window.addEventListener(WALLET_MODE_CHANGED_EVENT, (e) => {
    activeMode = (e as CustomEvent).detail as WalletMode;
    paint();
    // Re-pull both sources; the mode switch often follows a key-set
    // or a wallet-connect, so the address picture has likely changed.
    void refreshInternal().then(paint);
    void refreshExternal().then(paint);
  });
  window.addEventListener(KEYCHAIN_CHANGED_EVENT, () => {
    void refreshInternal().then(paint);
  });
}

function render(host: HTMLElement): void {
  const isInternal = activeMode === "internal";
  const address = isInternal ? internalAddress : externalAddress;
  const modeBadge = isInternal ? "INT" : "WC";
  const modeTitle = isInternal ? "Internal (paste-key)" : "WalletConnect";

  if (address) {
    host.dataset.state = "active";
    host.title = `${modeTitle} · ${address} — click to manage`;
    host.innerHTML = `
      <span class="wallet-pill-badge">${modeBadge}</span>
      <span class="wallet-pill-addr">${escapeHtml(shortHexAddress(address))}</span>
    `;
    return;
  }

  // No address for the active mode yet.
  host.dataset.state = "empty";
  host.title = isInternal
    ? "No wallet key set — click to set one in Settings → Advanced"
    : "No wallet connected — click to connect";
  host.innerHTML = `
    <span class="wallet-pill-badge">${modeBadge}</span>
    <span class="wallet-pill-addr wallet-pill-empty">${isInternal ? "set key" : "connect"}</span>
  `;
}

async function refreshInternal(): Promise<void> {
  try {
    const info = await invoke<InternalInfo | null>("internal_wallet_info");
    internalAddress = info?.address ?? null;
  } catch {
    internalAddress = null;
  }
}

async function refreshExternal(): Promise<void> {
  try {
    externalAddress = await currentAccount();
  } catch {
    externalAddress = null;
  }
}

let externalUnsub: (() => void) | null = null;
async function subscribeToExternalChanges(onChange: () => void): Promise<void> {
  if (externalUnsub) externalUnsub();
  externalUnsub = await onAccountChange((a) => {
    externalAddress = a.isConnected && a.address ? a.address : null;
    onChange();
  });
}

function goToWalletTab(): void {
  window.dispatchEvent(new CustomEvent("etchit:goto-tab", { detail: "wallet" }));
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
