# etch/it desktop — roadmap

Companion publisher to fetch>it. Tauri 2 + TS/Vite, palette and
conventions inherited from `fetchit/apps/fetchit-desktop`. This doc is
the canonical plan: a future session reading only this file (and the
code it points at) should be able to pick up without losing context.

## Where we are

Scaffold landed: `apps/etchit-desktop/`. Six-tab UI, three themes,
empty placeholder per tab except Settings, no functional uploads yet.
10 vitest pass (`theme/theme.test.ts`, `ui/tabBar.test.ts`).

```
apps/etchit-desktop/
├── index.html
├── package.json / vite.config.ts / tsconfig.json
├── src-tauri/                       Tauri 2 backend, no commands yet
└── src/
    ├── main.ts / controller.ts
    ├── types.ts                     TabId
    ├── styles.css                   3 themes via body[data-theme]
    ├── theme/                       load/apply/persist (localStorage)
    ├── ui/tabBar.ts                 top-bar tab strip
    └── tabs/
        ├── etch.ts                  placeholder — next to implement
        ├── blogger.ts               placeholder
        ├── website.ts               placeholder — desktop-only
        ├── history.ts               placeholder
        ├── wallet.ts                placeholder
        └── settings.ts              theme picker + about, functional
```

## Tab build-out order

Smallest first, each unblocks the next. Each shipped with its own
tests in the same commit (the rule from CLAUDE.md / feedback memory).

| # | Tab | What it does | Wallet needed? |
|---|---|---|---|
| 1 | **Etch** ✓ | Paste text or drop a file → returns an `autonomi://` address. The smallest possible upload UI. V0: native via `ant-ffi` path dep (same crate Android binds to), wallet key from OS keychain, `data_put_public` for text and `file_upload_public` for files. Neutral envelope, native file picker, result panel with Copy + Open-in-fetch>it. Long-lived `Client` cached in Tauri State so subsequent etches skip the ~10 s bootstrap warmup. | V0: paste hex key into Settings → Advanced → OS keychain. V1: WalletConnect Modal Web swaps the paste path for the external-signer flow (`prepare_public_upload` + `finalize_public_upload`, mirroring `EtchSigner.kt`) |
| 2 | **Blogger** | Title + body composer → publishes a self-contained HTML page following `docs/upload-neutrality.md` (no etch/it strings in the bytes). Parallel of `BlogHtml.kt` on Android | Same backend as Etch — `ant-ffi` direct, key from keychain |
| 3 | **History** | Local-only log of past etches (address + label + cost + timestamp), persisted in `settings.json`. No network calls; lives off what the upload tabs record at success time | None — local only |
| 4 | **Wallet** | Status panel: balance, approval budget, connection. WalletConnect Modal Web (browser-style SDK loaded in the Tauri WebView) | This is where wallet becomes native (replaces the shell-out path) |
| 5 | **Website** | Multi-file site builder. Drop a folder; etchit emits one entry-point address. Desktop-only by design — heavy file handling doesn't fit a phone | Native wallet by this point |
| 6 | **Settings** | Already functional in V0 (theme picker + about). Expand as other tabs need persistent prefs | None |

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

- **WalletConnect Modal Web in a Tauri WebView**: how does the modal dialog flow work when the WebView is the *only* window? Probably fine (the modal mounts in the same DOM), but to verify when Wallet tab is implemented.
- **Website-builder file format**: does the multi-file site go up as a ZIP (and fetch>it unpacks at render time), or as N individual addresses with one entry-point address pointing at a manifest? Decide when the tab is real.
- **History persistence shape**: `settings.json` is the obvious place but mixing user history with config feels wrong. Probably a separate `history.json` once the History tab is real.
