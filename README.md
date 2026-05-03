# etch/it

Permanent, decentralized text storage on the [Autonomi](https://autonomi.com) network. Etch text to the network forever. Fetch anything back.

## Install

Grab the latest signed APK from the [Releases page](https://github.com/etchit-io/etchit/releases).

1. Download `app-release.apk` from the most recent release.
2. On your Android device: Settings → Apps → Special access → **Install unknown apps** → enable for the browser or file manager you used to download it.
3. Open the APK and tap **Install**.
4. On first launch you'll be prompted to:
   - Allow notifications (used for wallet-approval and quotes-ready alerts).
   - Disable battery optimization for etchit (so the P2P connection stays alive during multi-minute uploads — Samsung devices in particular kill background apps aggressively otherwise).

You'll also need an Android wallet that speaks WalletConnect v2 (MetaMask, Rainbow, Trust Wallet, OKX) installed on the same device, with some ANT on Arbitrum One for writes. Reads are free.

**Requirements:** Android 8.0 (API 26) or newer. arm64 and x86_64 Android only.

## What it does

**Etch** — Write text, give it a title, tap Etch. The content is self-encrypted, split into chunks, and stored permanently on the Autonomi peer-to-peer network. You get a 64-character address that anyone can use to retrieve it. Reads are always free. Writes cost a small amount of ANT token paid on Arbitrum One.

**Private Etch** — Same as above, but the data map (the key to reassemble the chunks) stays on your device instead of being published on the network. Only you can retrieve it. Protected by your device's biometric or PIN lock.

**Fetch** — Enter any 64-character address to retrieve data from the network. Fetched content is detected automatically:
- Etchit-formatted text displays with title and content
- Images (PNG, JPEG, GIF, WEBP) display inline
- Raw text displays as-is
- Other files (video, PDF, etc.) save to Downloads with an option to open

**Library** *(optional, off by default)* — An encrypted on-chain index of your public etches that lets you find them on a different device. Settings → Library → Set up library, sign one message, and you have a wallet-bound encryption key cached on the device. Each entry you add — manually by address, or via the long-press action on a history row — costs one Arbitrum One transaction (~$0.02–$0.10 in ETH gas, no ANT). Restore from chain on a second device with the same wallet to see your entries. Private etches are not synced in v0.1; use the existing Backup & Restore flow to move them between devices. Wire format and full security/privacy disclosure live in [`docs/library-format-v1.md`](docs/library-format-v1.md).

## How it works

etchit connects directly to the Autonomi network via P2P (no server, no gateway, no middleman). All signing and payment is delegated to your external wallet (MetaMask, Rainbow, Trust, etc.) through WalletConnect — the app never touches your private keys.

### Payment flow

1. The network quotes a price in ANT tokens for storing your data
2. You review the cost and set an approval budget (default 20 ANT)
3. Your wallet approves the ANT spend (one-time until budget is used)
4. Your wallet signs the payment transaction
5. Data uploads to the network

The approval budget means most etches only need **one wallet prompt** instead of two. Once the budget is spent, you'll be prompted to approve again.

### Private etch security

Private data maps are stored in Android's `EncryptedSharedPreferences` backed by the hardware Keystore (AES-256). Accessing or retrieving a private etch requires biometric authentication (fingerprint, face) or your device PIN/pattern. Private data maps survive etch history clears and can only be deleted individually with confirmation.

### What the library key is

The library key is an AES decryption password your wallet auto-generates by signing a fixed message. It only decrypts your library — it can't sign transactions or move funds. Any device using the same wallet can re-derive the same key by signing the same message, which is how the library works across devices.

Two things people miss:
- It is **not** your wallet's private key. Leaking the library key lets someone read your library, nothing else — they cannot move funds or impersonate you.
- You don't pick it or store it like a normal password. The wallet generates it on demand from a signature; etchit caches it encrypted-at-rest. Backing it up is an *insurance* step in case the wallet ever stops producing the same signature on a new device.

For the full wire format and threat model, see [`docs/library-format-v1.md`](docs/library-format-v1.md).

## Building

```bash
./gradlew assembleDebug
```

**Requirements:**
- Android SDK (compile SDK 36, min SDK 26)
- JDK 17 or 21
- `local.properties` with:
  ```
  sdk.dir=/path/to/Android/Sdk
  REOWN_PROJECT_ID=your-walletconnect-project-id
  ```

Get a WalletConnect project ID from [cloud.reown.com](https://cloud.reown.com).

### Run tests

```bash
./gradlew testDebugUnitTest
```

### Rebuilding the native FFI (optional)

The Autonomi network code is a Rust library (`libant_ffi.so`) pre-built
and vendored under `app/src/main/jniLibs/`. You don't need to rebuild it
for normal development.

To rebuild from source (pinned deps, production-only, no devnet paths):

```bash
scripts/build-ffi.sh             # verify only
scripts/build-ffi.sh --swap      # rebuild, then drop into jniLibs
```

Everything is pinned and vendored under `ant-sdk/`. See
[`docs/FFI_BUILD.md`](docs/FFI_BUILD.md) for toolchain requirements,
version pins, and how to upgrade.

## Network

etchit connects to the Autonomi production network on launch using built-in bootstrap peers. Custom peers can be configured in Settings. The app requires **unrestricted battery** mode to maintain the P2P connection during long operations — a prompt guides you through this on first launch.

**Chain:** Arbitrum One (42161)
**Token:** ANT ([0xa78d...Db684](https://arbiscan.io/token/0xa78d8321B20c4Ef90eCd72f2588AA985A4BDb684))

## Tech stack

- Kotlin, single-Activity, XML/View-based UI
- Autonomi network access via `libant_ffi.so` (Rust FFI)
- WalletConnect v2 via Reown AppKit (Compose used only for the wallet modal)
- EVM contract interaction: hand-rolled ABI encoding, minimal JSON-RPC client
- No Retrofit, no Room, no Hilt — deliberately minimal dependencies

## License

GPL-3.0 — see [LICENSE](LICENSE).
