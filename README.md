# etch/it — desktop

Permanent, decentralized text storage on the [Autonomi](https://autonomi.com) network. Etch text to the network forever. Fetch anything back. Companion to the Android app at [etchit-io/etchit](https://github.com/etchit-io/etchit) — same protocol, same wallet, same chain/it list across devices.

## Install

Grab the latest build from the [Releases page](https://github.com/etchit-io/etchit-desktop/releases).

| Format | File | Best for |
|---|---|---|
| Portable | `etchit_<ver>_amd64.AppImage` | Any distro — `chmod +x` and run |
| Debian | `etchit_<ver>_amd64.deb` | Debian, Ubuntu, Mint |
| RPM | `etchit-<ver>-1.x86_64.rpm` | Fedora, RHEL, openSUSE |

You'll also need a wallet that speaks WalletConnect v2 — MetaMask Mobile (or any other WalletConnect wallet on your phone) pairs with the desktop client via QR. Browser-extension wallets work too where supported. You'll need some ANT on Arbitrum One for writes; reads are free.

**Status:** beta. Linux x86_64 today. Windows and macOS builds are planned and will be added to the same release tags as they're cross-built.

## What it does

**Etch** — Type text, give it a title, click Etch. The content is self-encrypted, split into chunks, and stored permanently on the Autonomi peer-to-peer network. You get a 64-character address that fetches the content back from any client. Reads are free; writes cost a small one-time ANT chunk fee.

**Private Etch** — Same flow, but the data map (the key to reassemble the chunks) stays on this device's encrypted local storage instead of being published. Only this device can decrypt — until you back up.

**Fetch** — Paste any 64-character address, click Fetch. Etchit-formatted text renders inline; raw text displays as-is; other files save to disk.

**Backup & Restore** — Export your private-etch data maps as one encrypted blob protected by an auto-generated 6-word passphrase, and ship it to the network as one more etch. On any device, paste the backup address + 6-word passphrase to restore.

**chain/it** *(optional, off by default)* — An encrypted on-chain index of your public etch addresses that follows your wallet across devices. Click *Sync chainmarks*, sign one message, and your list reappears. Each entry is encrypted with a chainmark key derived from your wallet's signature, then written as a tiny self-transaction on Arbitrum. The chain sees encrypted bytes and your wallet address — nothing else. There's also a [web viewer](https://etchit.io/chainmarks.html) — no install needed to read.

Wire format and full security/privacy disclosure for chain/it live in [`docs/chainmark-format-v1.md`](https://github.com/etchit-io/etchit/blob/main/docs/chainmark-format-v1.md) on the Android repo. This client is the third conformant implementation alongside the Kotlin reference and the static HTML / Python viewers.

## How it works

The desktop client connects directly to the Autonomi network via P2P through `libant_ffi.so` — the same Rust FFI the Android app ships. All signing and payment is delegated to your external wallet through WalletConnect; the app never touches your private keys.

### Payment flow

1. The network quotes a price in ANT tokens for storing your data
2. You review the cost and set an approval budget (default 20 ANT)
3. Your wallet approves the ANT spend (one-time until the budget is used)
4. Your wallet signs the payment transaction
5. Data uploads to the network

The approval budget means most etches only need **one wallet prompt** instead of two until the budget is spent.

### Private etch security

Private data maps are encrypted client-side with a key derived from a wallet `personal_sign`, then stored in this device's local storage. Without the same wallet — and a backup blob plus its 6-word passphrase — they're not recoverable on a fresh device.

## Build from source

Linux x86_64 today. Windows and macOS are supported by Tauri but require their respective build environments.

```bash
npm install
npm run tauri dev    # dev with hot-reload
npm run tauri build  # production binary + bundles (.AppImage, .deb, .rpm)
```

**Toolchain:**

- Rust stable
- Node 20+, npm 10+
- Tauri Linux prerequisites: `webkit2gtk-4.1-dev`, `libgtk-3-dev`, `librsvg2-dev`, `libayatana-appindicator3-dev`, `libxdo-dev`, `libssl-dev`, `build-essential`, `pkg-config`
- A WalletConnect project ID — get one from [cloud.reown.com](https://cloud.reown.com)

## Tech stack

- Tauri 2 (Rust backend + WebKit frontend)
- TypeScript + Vite (no UI framework — vanilla DOM)
- Reown AppKit for WalletConnect v2 + ethers
- Autonomi P2P via the same `libant_ffi.so` the Android app uses

## License

GPL-3.0 — see [LICENSE](LICENSE).
