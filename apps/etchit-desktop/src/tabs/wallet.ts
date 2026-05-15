// Wallet tab. Two panels driven by the wallet-mode preference:
//
// * Internal: derived address from the keychain key, on-chain ANT +
//   ETH balance, link to rotate / clear the key in Settings.
// * External: AppKit Connect button, connected address, ANT + ETH
//   balance for the connected wallet, AppKit "Manage" sheet for the
//   actual disconnect / chain controls.
//
// A mode switcher at the top lets the user flip between flows; the
// upload tabs branch on the same preference, so picking External here
// is what makes Etch / Blogger / Website route through the prepare /
// pay / finalize pipeline instead of the embedded keychain wallet.

import { invoke } from "@tauri-apps/api/core";
import { Contract, JsonRpcProvider } from "ethers";

import {
  currentAccount,
  onAccountChange,
  waitForConnection,
} from "../wallet/appkit";
import { formatToken, shortHexAddress } from "../wallet/balance";
import {
  ANT_TOKEN_ADDRESS,
  ARBITRUM_CHAIN_ID,
  ARBITRUM_RPC,
} from "../wallet/constants";
import {
  loadWalletMode,
  setWalletMode,
  WALLET_MODE_CHANGED_EVENT,
  type WalletMode,
} from "../wallet/mode";

interface InternalWalletInfo {
  address: string;
  ant_atto: string;
  eth_wei: string;
}

const ERC20_ABI = ["function balanceOf(address owner) view returns (uint256)"];
const rpc = new JsonRpcProvider(ARBITRUM_RPC, ARBITRUM_CHAIN_ID, { staticNetwork: true });
const antContract = new Contract(ANT_TOKEN_ADDRESS, ERC20_ABI, rpc);

let activeAppKitUnsub: (() => void) | null = null;
let activeModeListener: ((e: Event) => void) | null = null;

export function mountWallet(host: HTMLElement): void {
  host.innerHTML = `
    <div class="wallet-tab">
      <header class="wallet-header">
        <h1>Wallet</h1>
        <p class="wallet-lede">
          Etches cost a small amount of ANT on Arbitrum One. Reads are always free.
        </p>
      </header>

      <div class="wallet-mode-switcher" role="tablist">
        <button type="button" class="wallet-mode-tab" data-mode="internal" role="tab">Internal</button>
        <button type="button" class="wallet-mode-tab" data-mode="external" role="tab">WalletConnect</button>
      </div>

      <p class="wallet-mode-hint"></p>

      <section class="wallet-panel wallet-panel-internal" hidden></section>
      <section class="wallet-panel wallet-panel-external" hidden></section>
    </div>
  `;

  const root = host.querySelector(".wallet-tab") as HTMLElement;
  const hintEl = root.querySelector(".wallet-mode-hint") as HTMLElement;
  const internalEl = root.querySelector(".wallet-panel-internal") as HTMLElement;
  const externalEl = root.querySelector(".wallet-panel-external") as HTMLElement;
  const tabs = Array.from(root.querySelectorAll<HTMLButtonElement>(".wallet-mode-tab"));

  const applyMode = (mode: WalletMode): void => {
    for (const t of tabs) t.classList.toggle("is-active", t.dataset.mode === mode);
    internalEl.hidden = mode !== "internal";
    externalEl.hidden = mode !== "external";
    hintEl.textContent =
      mode === "internal"
        ? "Pays using the key in Settings → Advanced. The key signs every etch automatically."
        : "Connects a mobile or extension wallet. Every etch pops the wallet for an explicit signature.";
    if (mode === "internal") renderInternal(internalEl);
    else renderExternal(externalEl);
  };

  for (const t of tabs) {
    t.addEventListener("click", () => setWalletMode(t.dataset.mode as WalletMode));
  }

  if (activeModeListener) window.removeEventListener(WALLET_MODE_CHANGED_EVENT, activeModeListener);
  activeModeListener = (e) => applyMode((e as CustomEvent).detail as WalletMode);
  window.addEventListener(WALLET_MODE_CHANGED_EVENT, activeModeListener);

  applyMode(loadWalletMode());
}

function renderInternal(host: HTMLElement): void {
  host.innerHTML = `
    <div class="wallet-card">
      <div class="wallet-card-loading">Loading wallet…</div>
    </div>
  `;
  void invoke<InternalWalletInfo | null>("internal_wallet_info").then(
    (info) => {
      if (!info) {
        host.innerHTML = emptyInternalHtml();
        host.querySelector<HTMLButtonElement>(".wallet-empty-action")?.addEventListener(
          "click",
          () => focusSettingsAdvanced(),
        );
        return;
      }
      paintInternalCard(host, info);
    },
    (e: unknown) => {
      host.innerHTML = `<div class="wallet-card wallet-card-error"><strong>Couldn't load wallet</strong><p>${escapeHtml(String(e))}</p></div>`;
    },
  );
}

function paintInternalCard(host: HTMLElement, info: InternalWalletInfo): void {
  host.innerHTML = `
    <div class="wallet-card">
      <p class="wallet-card-label">Internal wallet · Arbitrum One</p>
      <div class="wallet-addr-row">
        <code class="wallet-addr" title="${escapeHtml(info.address)}">${escapeHtml(shortHexAddress(info.address))}</code>
        <button type="button" class="wallet-addr-copy" title="Copy address">Copy</button>
      </div>
      <div class="wallet-balances">
        <div class="wallet-balance">
          <span class="wallet-balance-amount">${formatToken(info.ant_atto)}</span>
          <span class="wallet-balance-symbol">ANT</span>
        </div>
        <div class="wallet-balance">
          <span class="wallet-balance-amount">${formatToken(info.eth_wei, 18, 5)}</span>
          <span class="wallet-balance-symbol">ETH</span>
        </div>
      </div>
      <p class="wallet-hint">
        Used for every etch while <strong>Internal</strong> mode is selected. Rotate or
        clear the key in <button type="button" class="wallet-link wallet-link-settings">Settings → Advanced</button>.
      </p>
      <button type="button" class="wallet-refresh">Refresh balance</button>
    </div>
  `;
  host.querySelector<HTMLButtonElement>(".wallet-addr-copy")?.addEventListener("click", () => {
    void navigator.clipboard.writeText(info.address).catch(() => {});
  });
  host.querySelector<HTMLButtonElement>(".wallet-link-settings")?.addEventListener("click", () =>
    focusSettingsAdvanced(),
  );
  host.querySelector<HTMLButtonElement>(".wallet-refresh")?.addEventListener("click", () =>
    renderInternal(host),
  );
}

function emptyInternalHtml(): string {
  return `
    <div class="wallet-card wallet-card-empty">
      <p class="wallet-card-headline">No wallet key set.</p>
      <p class="wallet-card-body">
        Etches need an Arbitrum One wallet with a small amount of ANT.
        Paste a key in <strong>Settings → Advanced</strong>, or switch
        to <strong>WalletConnect</strong> to sign with a mobile wallet
        instead.
      </p>
      <button type="button" class="wallet-empty-action">Open Settings → Advanced</button>
    </div>
  `;
}

function renderExternal(host: HTMLElement): void {
  host.innerHTML = `
    <div class="wallet-card wallet-card-loading">Checking wallet…</div>
  `;

  const paint = (address: string | null): void => {
    if (!address) {
      host.innerHTML = `
        <div class="wallet-card wallet-card-empty">
          <p class="wallet-card-headline">No wallet connected.</p>
          <p class="wallet-card-body">
            Connect a mobile or extension wallet. Every etch will pop a
            signing prompt — etch/it never sees your private key.
          </p>
          <button type="button" class="wallet-empty-action wallet-connect-btn">Connect wallet</button>
        </div>
      `;
      host.querySelector<HTMLButtonElement>(".wallet-connect-btn")?.addEventListener("click", () => {
        void waitForConnection().then(
          (addr) => paint(addr),
          () => {
            // user closed modal — leave the card alone
          },
        );
      });
      return;
    }
    paintExternalCard(host, address);
  };

  void currentAccount().then(paint, () => paint(null));

  if (activeAppKitUnsub) activeAppKitUnsub();
  void onAccountChange((a) => paint(a.isConnected && a.address ? a.address : null)).then((unsub) => {
    activeAppKitUnsub = unsub;
  });
}

function paintExternalCard(host: HTMLElement, address: string): void {
  host.innerHTML = `
    <div class="wallet-card">
      <p class="wallet-card-label">WalletConnect · Arbitrum One</p>
      <div class="wallet-addr-row">
        <code class="wallet-addr" title="${escapeHtml(address)}">${escapeHtml(shortHexAddress(address))}</code>
        <button type="button" class="wallet-addr-copy">Copy</button>
      </div>
      <div class="wallet-balances">
        <div class="wallet-balance">
          <span class="wallet-balance-amount" data-balance="ant">…</span>
          <span class="wallet-balance-symbol">ANT</span>
        </div>
        <div class="wallet-balance">
          <span class="wallet-balance-amount" data-balance="eth">…</span>
          <span class="wallet-balance-symbol">ETH</span>
        </div>
      </div>
      <p class="wallet-hint">
        Every etch signs in your wallet. Disconnect, switch chains, or change
        wallet through the AppKit sheet.
      </p>
      <button type="button" class="wallet-refresh">Refresh balance</button>
      <button type="button" class="wallet-manage">Manage wallet…</button>
    </div>
  `;

  host.querySelector<HTMLButtonElement>(".wallet-addr-copy")?.addEventListener("click", () => {
    void navigator.clipboard.writeText(address).catch(() => {});
  });
  host.querySelector<HTMLButtonElement>(".wallet-refresh")?.addEventListener("click", () =>
    loadExternalBalance(host, address),
  );
  host.querySelector<HTMLButtonElement>(".wallet-manage")?.addEventListener("click", () => {
    void waitForConnection().catch(() => {}); // re-opens modal when already connected
  });
  loadExternalBalance(host, address);
}

async function loadExternalBalance(host: HTMLElement, address: string): Promise<void> {
  const antEl = host.querySelector<HTMLElement>("[data-balance=\"ant\"]");
  const ethEl = host.querySelector<HTMLElement>("[data-balance=\"eth\"]");
  if (!antEl || !ethEl) return;
  antEl.textContent = "…";
  ethEl.textContent = "…";
  try {
    const [antAtto, ethWei] = await Promise.all([
      (antContract.balanceOf(address) as Promise<bigint>).then((b) => b.toString()),
      rpc.getBalance(address).then((b) => b.toString()),
    ]);
    antEl.textContent = formatToken(antAtto);
    ethEl.textContent = formatToken(ethWei, 18, 5);
  } catch (e: unknown) {
    antEl.textContent = "—";
    ethEl.textContent = "—";
    const card = host.querySelector(".wallet-card");
    if (card) {
      const note = document.createElement("p");
      note.className = "wallet-card-error-inline";
      note.textContent = `Balance lookup failed: ${String(e)}`;
      card.appendChild(note);
    }
  }
}

function focusSettingsAdvanced(): void {
  window.dispatchEvent(new CustomEvent("etchit:goto-tab", { detail: "settings" }));
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
