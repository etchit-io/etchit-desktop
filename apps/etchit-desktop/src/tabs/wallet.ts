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

import { formatErr } from "../util/error";
import {
  currentAccount,
  onAccountChange,
  openAppKit,
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

      <section class="wallet-card wallet-support">
        <h2>Support development</h2>
        <p class="wallet-support-blurb">
          etch<span class="brand-mark">/</span>it is open source and self-funded.
          If it&rsquo;s been useful, you can send a tip to the address below
          &mdash; any EVM chain.
        </p>
        <div class="settings-support-row">
          <code class="settings-support-addr">0xC842451eC3454913585B885240e58aa5E4F4ed2b</code>
          <button type="button" class="settings-support-copy">Copy address</button>
        </div>
        <p class="settings-support-status" role="status" aria-live="polite"></p>
      </section>
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
  mountSupport(root);
}

function mountSupport(root: HTMLElement): void {
  const addrEl = root.querySelector<HTMLElement>(".settings-support-addr");
  const copyBtn = root.querySelector<HTMLButtonElement>(".settings-support-copy");
  const status = root.querySelector<HTMLElement>(".settings-support-status");
  if (!addrEl || !copyBtn || !status) return;
  const address = addrEl.textContent?.trim() ?? "";
  copyBtn.addEventListener("click", () => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(address);
        status.textContent = "Address copied.";
        status.dataset.tone = "ok";
      } catch (e) {
        status.textContent = formatErr(e);
        status.dataset.tone = "error";
      }
    })();
  });
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
      host.innerHTML = `<div class="wallet-card wallet-card-error"><strong>Couldn't load wallet</strong><p>${escapeHtml(formatErr(e))}</p></div>`;
    },
  );
}

function paintInternalCard(host: HTMLElement, info: InternalWalletInfo): void {
  const lowFundsHtml = lowFundsBanner(info.ant_atto, info.eth_wei);
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
      ${lowFundsHtml}
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
            signing prompt — etch<span class="brand-mark">/</span>it never sees your private key.
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
    void openAppKit().catch(() => {});
  });
  loadExternalBalance(host, address);
}

async function loadExternalBalance(host: HTMLElement, address: string): Promise<void> {
  const antEl = host.querySelector<HTMLElement>("[data-balance=\"ant\"]");
  const ethEl = host.querySelector<HTMLElement>("[data-balance=\"eth\"]");
  if (!antEl || !ethEl) return;
  antEl.textContent = "…";
  ethEl.textContent = "…";
  // Drop any low-funds note from the previous balance load.
  host.querySelector(".wallet-lowfunds")?.remove();
  try {
    const [antAtto, ethWei] = await Promise.all([
      (antContract.balanceOf(address) as Promise<bigint>).then((b) => b.toString()),
      rpc.getBalance(address).then((b) => b.toString()),
    ]);
    antEl.textContent = formatToken(antAtto);
    ethEl.textContent = formatToken(ethWei, 18, 5);
    const html = lowFundsBanner(antAtto, ethWei);
    if (html) {
      const card = host.querySelector(".wallet-card");
      if (card) {
        const note = document.createElement("template");
        note.innerHTML = html.trim();
        const el = note.content.firstChild;
        if (el) card.insertBefore(el, host.querySelector(".wallet-hint"));
      }
    }
  } catch (e: unknown) {
    antEl.textContent = "—";
    ethEl.textContent = "—";
    const card = host.querySelector(".wallet-card");
    if (card) {
      const note = document.createElement("p");
      note.className = "wallet-card-error-inline";
      note.textContent = `Balance lookup failed: ${formatErr(e)}`;
      card.appendChild(note);
    }
  }
}

/** Render a low-funds prompt below the balance display when either
 *  ANT or ETH is at zero. Returns an empty string when both are
 *  non-zero — no banner needed. The check is strict zero rather than
 *  a threshold: any positive ANT means *some* etch fits, and gating
 *  on a guessed threshold either nags users with small wallets or
 *  fails to catch the "I never funded this" case. */
function lowFundsBanner(antAtto: string, ethWei: string): string {
  const noAnt = isZero(antAtto);
  const noEth = isZero(ethWei);
  if (!noAnt && !noEth) return "";
  let headline: string;
  let body: string;
  if (noAnt && noEth) {
    headline = "This wallet has no ANT or ETH.";
    body = "Fund it with a small amount of ETH (for gas) and ANT (for storage) on Arbitrum One before you try to etch.";
  } else if (noAnt) {
    headline = "This wallet has no ANT.";
    body = "Etching costs ANT on Arbitrum One. Send some to the address above and refresh.";
  } else {
    headline = "This wallet has no ETH.";
    body = "Etching needs a tiny amount of ETH for gas on Arbitrum One. Send a fraction of an ETH to the address above and refresh.";
  }
  return `
    <div class="wallet-lowfunds">
      <p class="wallet-lowfunds-headline">${escapeHtml(headline)}</p>
      <p class="wallet-lowfunds-body">${escapeHtml(body)}</p>
    </div>
  `;
}

function isZero(decimal: string): boolean {
  try {
    return BigInt(decimal) === 0n;
  } catch {
    return false;
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
