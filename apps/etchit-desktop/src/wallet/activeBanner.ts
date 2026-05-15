// Inline "Etching as …" banner. Mounted directly above the Etch button
// on Etch / Blogger / Website so the user can always see which wallet
// will pay for the next etch, and switch with one click.
//
// Driven by the same state as the top-bar pill, so flipping the wallet
// mode in any place updates the banner everywhere it's mounted.

import { invoke } from "@tauri-apps/api/core";

import { currentAccount, onAccountChange } from "./appkit";
import { shortHexAddress } from "./balance";
import {
  loadWalletMode,
  WALLET_MODE_CHANGED_EVENT,
  type WalletMode,
} from "./mode";
import { KEYCHAIN_CHANGED_EVENT } from "./statusPill";

interface InternalInfo {
  address: string;
  ant_atto: string;
  eth_wei: string;
}

/** Returns a cleanup function that unwires the listeners — call when
 *  the tab is remounted so we don't accumulate paint handlers. */
export function mountActiveWalletBanner(host: HTMLElement): () => void {
  let internalAddress: string | null = null;
  let externalAddress: string | null = null;
  let mode: WalletMode = loadWalletMode();

  const paint = (): void => {
    const isInternal = mode === "internal";
    const address = isInternal ? internalAddress : externalAddress;
    const modeLabel = isInternal ? "Internal" : "WalletConnect";
    host.innerHTML = "";
    const lead = document.createElement("span");
    if (address) {
      lead.innerHTML = `Etching as <strong>${escapeHtml(modeLabel)}</strong> · <code>${escapeHtml(shortHexAddress(address))}</code> · `;
    } else if (isInternal) {
      lead.innerHTML = `No wallet key set — etches will fail. `;
    } else {
      lead.innerHTML = `No wallet connected — clicking Etch will open WalletConnect. `;
    }
    const link = document.createElement("button");
    link.type = "button";
    link.className = "wallet-active-link";
    link.textContent = "Switch wallet";
    link.addEventListener("click", () =>
      window.dispatchEvent(new CustomEvent("etchit:goto-tab", { detail: "wallet" })),
    );
    host.appendChild(lead);
    host.appendChild(link);
  };

  const refreshInternal = async (): Promise<void> => {
    try {
      const info = await invoke<InternalInfo | null>("internal_wallet_info");
      internalAddress = info?.address ?? null;
    } catch {
      internalAddress = null;
    }
    paint();
  };

  const refreshExternal = async (): Promise<void> => {
    try {
      externalAddress = await currentAccount();
    } catch {
      externalAddress = null;
    }
    paint();
  };

  const onMode = (e: Event): void => {
    mode = (e as CustomEvent).detail as WalletMode;
    paint();
    void refreshInternal();
    void refreshExternal();
  };
  const onKeychain = (): void => {
    void refreshInternal();
  };

  paint();
  void refreshInternal();
  void refreshExternal();

  let appKitUnsub: (() => void) | null = null;
  void onAccountChange((a) => {
    externalAddress = a.isConnected && a.address ? a.address : null;
    paint();
  }).then((unsub) => {
    appKitUnsub = unsub;
  });

  window.addEventListener(WALLET_MODE_CHANGED_EVENT, onMode);
  window.addEventListener(KEYCHAIN_CHANGED_EVENT, onKeychain);

  return () => {
    window.removeEventListener(WALLET_MODE_CHANGED_EVENT, onMode);
    window.removeEventListener(KEYCHAIN_CHANGED_EVENT, onKeychain);
    appKitUnsub?.();
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
