# etch/it desktop — roadmap

Companion publisher to fetch>it. Tauri 2 + TS/Vite, palette and
conventions inherited from `fetchit/apps/fetchit-desktop`. This doc is
the canonical plan: a future session reading only this file (and the
code it points at) should be able to pick up without losing context.

## Where we are

All seven tabs shipped and functional. Three themes. Internal-wallet
(OS-keychain key) and WalletConnect (AppKit-on-Reown) both wired
across every upload flow. Private etches encrypted with a
keychain-persisted passphrase; encrypted data-map blobs go out as
public Autonomi etches so the library is portable cross-device with
just `(blob-address, passphrase)`. Idle disconnect, Settings theme +
About + wallet-key + passphrase, history backed by `history.json`,
private library backed by `private_store.json` plus a passphrase-
protected backup file. CI builds signed APKs on `v*` tags.

```
apps/etchit-desktop/
├── index.html
├── package.json / vite.config.ts / tsconfig.json
├── src-tauri/                       Tauri 2 — etch, wallet, private,
│                                    history, secrets, blog commands
└── src/
    ├── main.ts / controller.ts
    ├── types.ts                     TabId
    ├── styles.css                   3 themes via body[data-theme]
    ├── theme/                       load / apply / persist (localStorage)
    ├── ui/                          tab strip, modals, status pill
    ├── wallet/                      AppKit + internal-key paths
    ├── blog/ / website/             template + composer per tab
    ├── private/                     password modal, cipher blob,
    │                                session (keychain-persisted)
    ├── history/                     store + format
    └── tabs/                        one file per tab, mounted lazily
```

## Tab build-out order

Smallest first, each unblocks the next. Each shipped with its own
tests in the same commit (the rule from CLAUDE.md / feedback memory).

| # | Tab | What it does | Wallet |
|---|---|---|---|
| 1 | **Etch** ✓ | Text or file → returns an `autonomi://` address. `ant-ffi` direct (same crate Android binds to), bundling for ≥2 picks or folders becomes a ZIP. Required user Title field stored only in local `history.json`; the uploaded bytes carry zero etch/it identification. Long-lived `Client` cached in Tauri State so subsequent etches skip the ~10 s bootstrap warmup | Internal (paste-key keychain) or WalletConnect (AppKit external-signer) |
| 2 | **Blogger** ✓ | Title + body composer → self-contained HTML following `docs/upload-neutrality.md`. Same upload path as Etch | Internal or WalletConnect |
| 3 | **Website** ✓ | **Template-based single-HTML builder** (landing / personal / portfolio). Composer slots → preview iframe → etch as one neutral HTML doc with assets inlined as data URIs. Originally planned as folder-drop ZIP; templates better fit the idiot-proof UX target. ⌘P preview, ⌘↩ etch | Internal or WalletConnect |
| 4 | **Private** ✓ | Password-encrypted etches. Each entry's data-map is encrypted with a session passphrase + uploaded to the public network as a separate etch; library stays portable cross-device with `(blob-address, passphrase)`. Session passphrase persists in the OS keychain so subsequent launches don't re-prompt. Backup export wraps the entries JSON under the same passphrase | Internal or WalletConnect |
| 5 | **History** ✓ | Local-only log (`history.json`). Per-row Copy / Open-in-fetchit / Delete; clear-all confirmed via plugin-dialog | None |
| 6 | **Wallet** ✓ | Mode switcher (Internal / WalletConnect). Internal shows derived address + ANT/ETH on Arbitrum One; WalletConnect connects via AppKit and exposes the manage sheet | Both modes implemented |
| 7 | **Settings** ✓ | Theme picker, bootstrap-peer override (advanced), wallet-key paste (advanced), private-passphrase status + clear (advanced), About | None |

## UX principles

etchit's primary audience is *tech-curious people trying something they
don't fully understand*. The default surface must be idiot-proof — every
common path usable without docs, every button labelled in plain English,
no jargon, no preconditions. Power features live behind a clearly
labelled **Advanced** section in Settings.

| Surface | Stance |
|---|---|
| Main UI (Etch, Blogger, History, Wallet, Website tabs) | Always idiot-proof. Should work for a user who's never heard of "private keys" or "data maps" |
| Settings → Advanced | Paste-key wallet, custom bootstrap peers, payment-mode override, chain/it sync, devnet, anything that requires the user to understand what could go wrong |

**Risk framing for Advanced features.** Vague "at your own risk" is not
a warning — it tells the user nothing. Where a feature carries risk, the
copy must be specific. The paste-key Advanced panel says:

> Use a dedicated upload wallet, fund it small, treat it as hot.

Not: "store keys at your own risk." A specific instruction is a real
warning; a hedged disclaimer is fence-sitting.

## Locked decisions

| Decision | Why |
|---|---|
| Tauri 2, not native (Swift / Win-native) | One codebase covers desktop + iOS + (eventually) Android. Single solo-dev maintainable. See `fetchit/CLAUDE.md` for the matching rationale |
| Link `ant-ffi` directly (path dep, Rust→Rust) | `ant-ffi` is etchit's own upload crate — the same one Android binds to via UniFFI. Calling from Tauri Rust skips the FFI layer entirely. No third-party `ant` CLI as a runtime dependency. Heavy transitive deps (`ant-node`, `evmlib`, `saorsa-*`) make the first build slow; that's the cost of native |
| OS keychain for every stored secret | Never `.env` (leaks via commits and home-dir scrapers), never plain `settings.json` (grep-able by any process or backup). `keyring` crate covers macOS Keychain / Windows Credential Manager / Linux libsecret in one API |
| WalletConnect Modal Web for V1 native wallet | Browser-shaped SDK, runs inside Tauri's WebView, same code path for iOS later. V1 swaps the V0 paste-key path for the external-signer flow (`prepare_public_upload` + `finalize_public_upload`, mirroring `EtchSigner.kt`). Reown AppKit on Android is platform-specific — leave that for the Kotlin app until we migrate |
| Three themes: dark (default) / dim / light | Brand is dark; offer a softer alternative for users who don't want full dark. Driven by `body[data-theme]` + CSS custom properties; no theme-specific JS branching |
| Tab state lazily mounted, persistent on switch | `controller.ts` mounts a tab the first time it's visited and leaves it in the DOM (just `hidden`). Switching tabs preserves user state without remount work |
| One file per tab, one concern per module | Per `feedback-modular-desktop` memory. No monolith files |
| Uploads carry no etch/it identification | See `docs/upload-neutrality.md`. Blog / Website tabs MUST emit user-content-only HTML — tests assert no literal `etchit` strings in output |

## Mobile / iOS / Android long-arc

| Surface | Status | Plan |
|---|---|---|
| Android (Kotlin, this repo's `app/`) | Shipping | **Stays as-is** through the desktop build-out. Retire only after Tauri-iOS proves the WebView path is good enough for production write flows |
| iOS | Not yet | **Defer indefinitely.** Apple's App Store review is hostile to crypto / WalletConnect apps. Cost / value bad until there's a demonstrated audience for create-on-mobile from iPhone users. fetch>it iOS goes first; etch/it iOS waits |
| Desktop Linux / macOS / Windows | Building now | Tauri 2 cross-platform. `tauri build` on each host. Plan: ship together once Etch + Blogger + Wallet are real |

The endgame is one Tauri codebase covering desktop + iOS + Android.
We get there incrementally — desktop now, iOS spike via fetchit (test
the path), then iOS for etchit if it's clean, then migrate Android.
We do **not** introduce a permanent "WebView iOS + native Android"
inconsistency; it's a transitional middle, not a destination.

## Coupling with fetch>it

- **Brand**: copper / bone / ink palette, mono mark; `etch/it` wordmark mirrors `fetch>it`. Where fetchit's chevron is `>`, etchit's is `/`.
- **Window title**: `[ / ]` (parallel to fetchit's `[ > ]`).
- **QR sharing**: out of scope for etchit-desktop V0 — it's a *publishing* tool. Reading + QR-sharing live in fetch>it. If etchit ever shows the address after a successful upload (it will), it links the user to fetch>it for QR / share.
- **Spec sharing**: shared design docs live in either repo when they describe a contract spanning both. `fetchit/docs/QR-SHARE.md` is the canonical example.

## Open questions

- **WalletConnect Modal Web in a Tauri WebView**: AppKit loads and signs successfully in the WebView; the open question now is real-world reliability — wallet-popup focus restore, deep-link return from mobile wallets, and disconnect handling under prolonged sessions. Worth a deliberate end-to-end pass before any public release.
- **Pre-persistence orphaned private etches**: until the keychain-persisted session passphrase landed, each app launch could generate a new passphrase, so older private etches in any given user's library may be encrypted with different transient passphrases. `dataMapFor` has a one-shot retry modal for opening these per-entry, but there's no "scan & sort by passphrase" recovery tool.

## Resolved

- **Website-builder file format**: settled as single-HTML templates with inline assets, not folder-drop ZIP.
- **History persistence shape**: separate `history.json` in the app data dir; tab is fully shipped.
