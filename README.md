# etchit-desktop

Desktop client for [etchit](https://etchit.io) — a decentralized
pastebin on the [Autonomi](https://autonomi.com) network. Companion to
the Android app at [etchit-io/etchit](https://github.com/etchit-io/etchit).

> **Status: pre-alpha.** Phase 1 ships the library viewer only; etch /
> fetch / private-etch are coming in Phase 2+.

## What Phase 1 does

The same library viewer that runs at <https://etchit.io/library>, but as
a standalone desktop app. Decrypts your on-chain library entries
client-side and lists them, with the matching `ant-cli` command per
entry for fetching content from a terminal.

Inputs: wallet address + the 32-byte library key from the mobile app
(Settings → Library → Back up library key). Or, if you have a browser-
extension wallet on your desktop, click *Connect wallet* and the key is
re-derived from a `personal_sign` automatically.

## Roadmap

- **Phase 2** — link `libant_ffi.so` (the same Rust FFI the Android app
  ships) and replace ant-cli copy-actions with in-app fetch.
- **Phase 3** — etch + private-etch + full feature parity with mobile.
- **Phase 4** — macOS + Windows builds. Linux x86_64 only for v0.1.

## Build

Linux x86_64 only for now.

```bash
npm install
npm run tauri dev    # dev with hot-reload
npm run tauri build  # production binary
```

Toolchain: Rust stable, Node 20+, npm 10+, plus the Tauri Linux
prereqs (`webkit2gtk-4.1-dev`, `libgtk-3-dev`, `librsvg2-dev`,
`libayatana-appindicator3-dev`, `libxdo-dev`, `libssl-dev`,
`build-essential`, `pkg-config`).

## Spec

The library protocol (HKDF + AES-GCM + on-chain replay) is specified in
[`docs/library-format-v1.md`](https://github.com/etchit-io/etchit/blob/main/docs/library-format-v1.md)
in the Android repo. This client is the third conformant
implementation alongside the Kotlin reference (`app/`) and the static
HTML / Python CLI viewers (`tools/`).

## License

GPL-3.0.
