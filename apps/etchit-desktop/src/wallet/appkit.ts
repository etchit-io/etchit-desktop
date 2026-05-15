// Reown AppKit (WalletConnect v2) singleton. Lazy-initialised because
// the SDK ships ~300 KB of code we don't want to pay for on startup —
// the user only feels it when they touch the Wallet tab or attempt an
// etch in External mode.
//
// AppKit-in-Tauri-WebView is a proven path: the previous desktop
// (`josh-clsn/etchit-desktop-old`) shipped this exact configuration and
// shipped working QR-pairing with mobile wallets.

import type { Eip1193Provider } from "ethers";

import { ANT_TOKEN_ADDRESS, REOWN_PROJECT_ID } from "./constants";

export type AppKitAccount = { isConnected?: boolean; address?: string };

interface AppKitLike {
  open(): Promise<void>;
  getAccount(): AppKitAccount | undefined;
  getWalletProvider(): Eip1193Provider | undefined;
  subscribeAccount(cb: (a: AppKitAccount) => void): () => void;
}

let cached: AppKitLike | null = null;

/** Lazy AppKit getter. First call builds the singleton; later calls
 *  return the same instance. */
export async function getAppKit(): Promise<AppKitLike> {
  if (cached) return cached;
  const [{ createAppKit }, { EthersAdapter }, networksMod] = await Promise.all([
    import("@reown/appkit"),
    import("@reown/appkit-adapter-ethers"),
    import("@reown/appkit/networks"),
  ]);
  const { arbitrum } = networksMod as { arbitrum: unknown };
  cached = createAppKit({
    adapters: [new EthersAdapter()],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    networks: [arbitrum as any],
    projectId: REOWN_PROJECT_ID,
    metadata: {
      name: "etchit",
      description: "Publish to Autonomi",
      url: "https://etchit.io",
      icons: ["https://etchit.io/icon.svg"],
    },
    // Surfaces ANT next to ETH in AppKit's own Manage modal so users
    // see both balances when they pop the wallet sheet.
    tokens: {
      "eip155:42161": { address: ANT_TOKEN_ADDRESS },
    },
    features: { analytics: false, email: false, socials: false },
  }) as unknown as AppKitLike;
  return cached;
}

/** Open the modal and resolve when the user has paired a wallet. */
export async function waitForConnection(): Promise<string> {
  const kit = await getAppKit();
  const current = kit.getAccount();
  if (current?.isConnected && current.address) return current.address;
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const unsub = kit.subscribeAccount((a) => {
      if (settled) return;
      if (a.isConnected && a.address) {
        settled = true;
        unsub();
        resolve(a.address);
      }
    });
    kit.open().catch((e: unknown) => {
      if (settled) return;
      settled = true;
      unsub();
      reject(e instanceof Error ? e : new Error(String(e)));
    });
  });
}

/** Snapshot of the currently-connected wallet, if any. Does not open
 *  the modal — returns `null` when no session is active. */
export async function currentAccount(): Promise<string | null> {
  const kit = await getAppKit();
  const acct = kit.getAccount();
  return acct?.isConnected && acct.address ? acct.address : null;
}

/** EIP-1193 provider for the connected wallet (or `null` if none). */
export async function currentProvider(): Promise<Eip1193Provider | null> {
  const kit = await getAppKit();
  return kit.getWalletProvider() ?? null;
}

/** Subscribe to account changes (connect, disconnect, chain switch).
 *  Returns the unsubscribe function. */
export async function onAccountChange(handler: (a: AppKitAccount) => void): Promise<() => void> {
  const kit = await getAppKit();
  return kit.subscribeAccount(handler);
}
