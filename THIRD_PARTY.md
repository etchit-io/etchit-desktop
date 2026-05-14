# Third-Party Licenses

etchit is dual-licensed under AGPL-3.0-only and a separate commercial
license (see `COMMERCIAL.md`). It uses the following open-source
libraries:

## Autonomi Network
- **ant-core / ant-client** — GPL-3.0 — https://github.com/WithAutonomi/ant-client
- **ant-node** — GPL-3.0 — https://github.com/WithAutonomi/ant-node
- **ant-ffi** (libant_ffi.so, vendored in `jniLibs/`) — GPL-3.0 — fork of https://github.com/WithAutonomi/ant-sdk with app-specific additions (see `docs/FFI_BUILD.md`)
- **evmlib** — GPL-3.0 — https://github.com/WithAutonomi/evmlib
- **saorsa-core** — AGPL-3.0 — https://github.com/saorsa-labs/saorsa-core (transitive via ant-node; not a direct dependency)

## Reown (WalletConnect)
- **AppKit Android SDK** — Apache-2.0 — https://github.com/reown-com/reown-kotlin

## AndroidX
- appcompat, core-ktx, lifecycle, security-crypto, biometric, compose — Apache-2.0 — https://developer.android.com/jetpack

## Other
- **JNA** — Apache-2.0 / LGPL-2.1
- **Material Components** — Apache-2.0
- **Accompanist** — Apache-2.0
