# Architecture

A short tour for new contributors. Read this once and you should know
roughly where to start when you want to change something.

For build commands, gradle settings, and SDK targets see
[`CLAUDE.md`](CLAUDE.md). For FFI rebuild instructions see
[`docs/FFI_BUILD.md`](docs/FFI_BUILD.md).

## High-level shape

etchit is a single-Activity Android app. There is one `MainActivity`
that owns the host shell — network lifecycle, top-level XML layout
binding, and the dialogs that live closest to the etch flow. Everything
else is split into small focused files under
`app/src/main/java/com/autonomi/antpaste/`:

| Package | What lives there |
|---------|------------------|
| `(root)` | App basics: `MainActivity`, `EtchitApplication`, content classifiers, the shared `Terms`, the `KeepAliveService` foreground stub, paste/data utils. |
| `net/` | Network plumbing: bootstrap-peer parsing, FFI progress tailing. |
| `wallet/` | Wallet transport: `WalletSession` (Reown AppKit), `WalletSigner` (callback → suspend bridge), JSON-RPC client, ABI encoders. |
| `vault/` | Anything that signs, encrypts, or persists secrets: `EtchSigner` (the four-step etch state machine), `BackupPassphraseCache`, `ResumableEtchStore`. |
| `chainmark/` | The on-chain encrypted index ("chain/it"): controller, key manager, AES-GCM payload codec, indexer client, sync engine. |
| `ui/` | Reusable dialogs and screens. Each file is one self-contained UI surface. |

There is **no DI framework**. Cross-cutting singletons (the wallet
session, the FFI client) live on `EtchitApplication` and are reached
via `(application as EtchitApplication).walletSession`. Everything
else is constructed in `MainActivity.onCreate` and either kept on
`MainActivity` or passed by constructor into one of the `ui/`
components.

## How `MainActivity` is organised

`MainActivity.kt` is intentionally still the largest file in the
project — it owns the etch lifecycle, the network connection, and
glues the rest together. Inside it you'll find, in roughly this
order:

1. **Companion constants** — brand colours, timing constants, size caps.
2. **Field declarations** — UI binding, prefs, FFI client, the wallet
   session, the extracted `ui/` and `vault/` components.
3. **Activity lifecycle** — `onCreate`, `onNewIntent`, etc. `onCreate`
   wires up every extracted component (see "Wiring" below).
4. **Network lifecycle** — `connectToNetwork`, warm-up, peer probing.
5. **Etch flow** — the main `confirmAndEtch` (public/private) plus
   `etchBackupData` (used by `BackupCreateFlow`).
6. **Fetch flow** — `retrievePaste`, `retrievePrivateEtch`, dispatch
   into `ResultCardView`.
7. **Settings sheet** — `showSettings()`. This is a dispatcher to the
   other surfaces; it stays inline because every button routes into
   MainActivity-owned state. Intentionally not extracted.
8. **Private etches sheet** — `openPrivateEtches`, biometric gate,
   list rendering. Hands off backup creation to `BackupCreateFlow`.
9. **`currentWalletAddress` + `etchBackupData`** — the host-side
   pieces of the backup-create flow.
10. **Various helpers** — clipboard, status bar, haptics, copy.

## Wiring (`onCreate`)

`onCreate` is the single source of truth for how the components hang
together. The pattern is consistent: each extracted component takes
its dependencies through its constructor, and `MainActivity` passes
either fields, lambdas, or method references.

```kotlin
resultCard = ResultCardView(
    activity = this,
    binding = binding,
    onShowStatus = ::showStatus,
    onCopy = ::copyToClipboard,
    onHaptic = ::hapticSuccess,
    onBackupDetected = ::promptRestoreBackup,
)

chainmarkScreen = ChainmarkScreen(
    activity = this,
    walletSession = walletSession,
    chainmarkController = chainmarkController,
    etchHistory = etchHistory,
    lifecycleScope = lifecycleScope,
    onShowStatus = ::showStatus,
)

backupPassphraseCache = BackupPassphraseCache(encryptedPrefs)
backupCreateFlow = BackupCreateFlow(
    activity = this,
    snackbarAnchor = binding.root,
    walletSession = walletSession,
    privateDataStore = privateDataStore,
    passphraseCache = backupPassphraseCache,
    onShowStatus = ::showStatus,
    onEtchBackup = ::etchBackupData,
)
```

If you're adding a new screen or dialog, follow this pattern: create
a new file in `ui/`, take dependencies through the constructor,
expose one or two public entry points, wire it up in `onCreate`.

## The `ui/` package

Each file in `ui/` is one self-contained surface. Some are top-level
functions (no shared state across calls), others are classes (shared
state across method calls). Both styles are fine — pick the one that
fits the surface.

| File | What it is |
|------|------------|
| `BackupCreateFlow.kt` | The dialog stack for creating an encrypted backup of the user's private etches. Hands the encrypted blob back to MainActivity for the actual etch. |
| `BackupRestorePrompt.kt` | The 6-word passphrase grid + custom-password fallback shown when fetched bytes look like an encrypted backup. |
| `ChainmarkScreen.kt` | The chain/it bottom-sheet — entry list, sync, add/bulk-add, hide, key backup/restore. Single class with one public `show()`. |
| `FullScreenTextDialog.kt` | The fullscreen text editor used for both viewing fetched text and editing private etches. |
| `HistoryViewer.kt` | The "Etch History" sheet with copy / fetch / add-to-chainmarks / remove actions. |
| `ResultCardView.kt` | The result card under the input — animation, content-type dispatch (text / image / binary / backup / etch envelope), save-to-Downloads. |
| `WalletModalHost.kt` | The Compose host that mounts the Reown AppKit modal. Compose is used here only — everything else is XML/View. |

## The `vault/` package

Everything that signs, encrypts, or persists secrets:

| File | What it is |
|------|------------|
| `EtchSigner.kt` | The four-step etch state machine: collect quotes → approve ANT → pay vault → finalize upload. Public uploads publish a data map; private uploads keep it local. |
| `BackupPassphraseCache.kt` | EncryptedSharedPreferences wrapper for the per-wallet backup passphrase. Used by both `BackupCreateFlow` and `BackupRestorePrompt`. |
| `ResumableEtchStore.kt` | Persists an in-flight etch across process death so a retry after a crash can finalize without re-paying. |
| `PaymentVault.kt` | ABI encoder for the vault's `payForQuotes` function. |

## The `chainmark/` package

"chain/it" is etchit's encrypted on-chain index — a list of the user's
public etch addresses, AES-GCM encrypted with a wallet-derived key,
written as Arbitrum self-transactions. See
[`docs/chainmark-format-v1.md`](docs/chainmark-format-v1.md) for the
wire format.

Key files:

- `ChainmarkController.kt` — the public API the rest of the app uses.
- `ChainmarkKeyManager.kt` — derives the AES-GCM key from a wallet signature on first use, caches it in EncryptedSharedPreferences.
- `ChainmarkSync.kt` — pulls historical entries from the indexer, decrypts, deduplicates.
- `ArbiscanIndexer.kt` / `IndexerClient.kt` — abstraction over the chain indexer (Arbiscan by default; user-configurable).
- `ChainmarkPayload.kt` — encrypt / decrypt a single entry.
- `ChainmarkReplay.kt` — replay-protection state machine (entries are append-only with hide tombstones).

## The FFI

Reads and writes go through `libant_ffi.so` — a Rust library generated
from `ffi/rust/ant-ffi/` via uniffi 0.29.4. The shipping `.so` is a
fork of `WithAutonomi/ant-sdk` with three app-specific additions
(`preparePublicUpload`, `finalizePublicUpload`, `peerCount`) and a
Merkle-path rejection. Do not replace the `.so` blindly with upstream
— that would regress core functionality. See
[`docs/FFI_BUILD.md`](docs/FFI_BUILD.md) for rebuild instructions.

The FFI is sandboxed by Android UID, so progress events are streamed
out of the app's own logcat by `net/ProgressTail.kt` — no special
permission needed.

## Long-running operations

P2P uploads and fetches can take minutes. To survive backgrounding:

- `KeepAliveService` is a foreground service declared in the manifest.
- `OperationHelper` starts/stops it around long operations.
- The FFI client lifecycle (`nativeClient`) is owned by `MainActivity`.

Some OEMs (notably Samsung) still kill the service aggressively —
hardening this is open work.

## Wallet integration

`WalletSession` implements `AppKit.ModalDelegate` and exposes a
`StateFlow<SessionState>` (Disconnected → Connecting → Connected → Error).
`WalletSigner` bridges AppKit's callback-based signing API to coroutine
suspend functions using a `ConcurrentHashMap<Long, CancellableContinuation>`
keyed by request ID. `EtchSigner` orchestrates the full external-signer
etch flow on top of those two.

A patched `com.reown:android-core` AAR is vendored under `local-maven/`
(ChaChaPolyCodec thread-safety fix). Patch source:
<https://github.com/etchit-io/reown-kotlin> tag `1.6.12-etchit.1`.
See `local-maven/README.md` for details.

Reown transitively pulls in Firebase and GMS; both are explicitly
excluded in `app/build.gradle.kts` so the APK qualifies for IzzyOnDroid
/ F-Droid. etchit uses a foreground service + heads-up notifications
instead of FCM. **Any new Reown- or push-related dependency must keep
these exclusions.**

## Data envelope format

Etches are wrapped in a JSON envelope:

```json
{"v":1,"meta":{"title":"...","created_at":1700000000},"content":"..."}
```

Encoding/decoding lives in `PasteUtils.kt`. `ContentDetector.kt`
classifies fetched bytes into one of five types — `ETCH_ENVELOPE`,
`BACKUP`, `IMAGE`, `TEXT`, `BINARY` — and `ResultCardView` branches
on the result.

## Testing

Unit tests cover the pure/stateless layers (ABI encoding, envelope
parsing, chainmark crypto). Run with `./gradlew testDebugUnitTest`.
There are no instrumented tests. Tests use JUnit 4 with golden-value
assertions — no mocking frameworks.
