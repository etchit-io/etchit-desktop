// Top-bar wallet status pill. Always-visible answer to "what will pay
// when I click Etch?". Shows the active mode badge + balances (ANT
// then ETH) for whichever wallet is active. Address lives in the
// inline `activeBanner` on each upload tab — no need to duplicate.
//
// Click anywhere on the pill → jump to the Wallet tab.

import { invoke } from "@tauri-apps/api/core";
import { Contract, JsonRpcProvider } from "ethers";

import { currentAccount, onAccountChange } from "./appkit";
import { formatToken, shortHexAddress } from "./balance";
import {
  ANT_TOKEN_ADDRESS,
  ARBITRUM_CHAIN_ID,
  ARBITRUM_RPC,
} from "./constants";
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

/** Fired by the Settings tab when the keychain key is set or cleared. */
export const KEYCHAIN_CHANGED_EVENT = "etchit:keychain-changed";

const ERC20_ABI = ["function balanceOf(address owner) view returns (uint256)"];
const rpc = new JsonRpcProvider(ARBITRUM_RPC, ARBITRUM_CHAIN_ID, { staticNetwork: true });
const antContract = new Contract(ANT_TOKEN_ADDRESS, ERC20_ABI, rpc);

interface WalletSnapshot {
  address: string | null;
  antAtto: string | null;
  ethWei: string | null;
}

let internal: WalletSnapshot = { address: null, antAtto: null, ethWei: null };
let external: WalletSnapshot = { address: null, antAtto: null, ethWei: null };
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
    void refreshInternal().then(paint);
    void refreshExternal().then(paint);
  });
  window.addEventListener(KEYCHAIN_CHANGED_EVENT, () => {
    void refreshInternal().then(paint);
  });
}

function render(host: HTMLElement): void {
  const isInternal = activeMode === "internal";
  const snap = isInternal ? internal : external;
  const modeBadge = isInternal ? "INT" : "WC";
  const modeTitle = isInternal ? "Internal (paste-key)" : "WalletConnect";

  if (!snap.address) {
    host.dataset.state = "empty";
    host.title = isInternal
      ? "No wallet key set — click to set one in Settings → Advanced"
      : "No wallet connected — click to connect";
    host.innerHTML = `
      <span class="wallet-pill-badge">${modeBadge}</span>
      <span class="wallet-pill-empty">${isInternal ? "no key" : "connect"}</span>
    `;
    return;
  }

  host.dataset.state = "active";
  const ant = snap.antAtto ? formatToken(snap.antAtto) : "…";
  const eth = snap.ethWei ? formatToken(snap.ethWei, 18, 4) : "…";
  host.title = `${modeTitle} · ${shortHexAddress(snap.address)} — click for details`;
  host.innerHTML = `
    <span class="wallet-pill-badge">${modeBadge}</span>
    <span class="wallet-pill-balance">
      <span class="wallet-pill-amount">${ant}</span>
      <span class="wallet-pill-symbol">ANT</span>
    </span>
    <span class="wallet-pill-sep">·</span>
    <span class="wallet-pill-balance">
      <span class="wallet-pill-amount">${eth}</span>
      <span class="wallet-pill-symbol">ETH</span>
    </span>
  `;
}

async function refreshInternal(): Promise<void> {
  try {
    const info = await invoke<InternalInfo | null>("internal_wallet_info");
    if (!info) {
      internal = { address: null, antAtto: null, ethWei: null };
      return;
    }
    internal = { address: info.address, antAtto: info.ant_atto, ethWei: info.eth_wei };
  } catch {
    internal = { address: null, antAtto: null, ethWei: null };
  }
}

async function refreshExternal(): Promise<void> {
  try {
    const addr = await currentAccount();
    if (!addr) {
      external = { address: null, antAtto: null, ethWei: null };
      return;
    }
    // Snapshot the address right away; balances will populate when
    // the RPC calls land. The pill renders "…" in the gap.
    external = { address: addr, antAtto: null, ethWei: null };
    const [antAtto, ethWei] = await Promise.all([
      (antContract.balanceOf(addr) as Promise<bigint>).then((b) => b.toString()),
      rpc.getBalance(addr).then((b) => b.toString()),
    ]);
    external = { address: addr, antAtto, ethWei };
  } catch {
    // Keep whatever address we have, drop balances.
    external = { address: external.address, antAtto: null, ethWei: null };
  }
}

let externalUnsub: (() => void) | null = null;
async function subscribeToExternalChanges(onChange: () => void): Promise<void> {
  if (externalUnsub) externalUnsub();
  externalUnsub = await onAccountChange((a) => {
    if (a.isConnected && a.address) {
      external = { address: a.address, antAtto: null, ethWei: null };
      onChange();
      void refreshExternal().then(onChange);
    } else {
      external = { address: null, antAtto: null, ethWei: null };
      onChange();
    }
  });
}

function goToWalletTab(): void {
  window.dispatchEvent(new CustomEvent("etchit:goto-tab", { detail: "wallet" }));
}
