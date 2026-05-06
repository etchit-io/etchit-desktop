# libant_ffi.so — provenance and rebuild

Single source of truth for the vendored Autonomi native library — where it
comes from, what's pinned, and how to rebuild from scratch. Keep this file
in sync with the `.so` in `app/src/main/jniLibs/`.

## What's shipped

- `app/src/main/jniLibs/arm64-v8a/libant_ffi.so`
- `app/src/main/jniLibs/x86_64/libant_ffi.so`
- `app/src/main/java/uniffi/ant_ffi/ant_ffi.kt` (auto-generated uniffi
  bindings)

## Fork deltas vs. `WithAutonomi/ant-sdk`

`ant-ffi` in the shipping `.so` is NOT a clean build of upstream
`WithAutonomi/ant-sdk`. It has three additions on top of upstream's public
API:

1. `prepare_public_upload(data)` → `PreparePublicUploadResult`
2. `finalize_public_upload(upload_id, tx_hashes)` → `PublicUploadResult`
3. `peer_count() -> u64`

And one behavior change:

4. When `ant-core` returns `ExternalPaymentInfo::Merkle` (for uploads
   ≥ 64 chunks ≈ 256 MiB), the FFI explicitly errors with
   `"merkle payment path not supported over FFI"` /
   `"merkle payment path not supported by prepare_public_upload"` instead of
   crashing or silently dropping the payments.

`preparePublicUpload` / `finalizePublicUpload` are called from
`EtchSigner` and `peerCount()` from `MainActivity`. Any rebuild must
preserve these symbols.

## Why this matters for small-text uploads (this app's only use case)

- Etch UI only surfaces text input — no file picker, no image upload.
  Practical max payload is far below 256 MiB.
- Backup blob is encrypted data-map metadata, not user content — also
  small.
- So uploads never cross the Merkle threshold, and the FFI's WaveBatch
  code path is the only one exercised in practice. The Merkle rejection is
  defense-in-depth.

## When to rebuild

You do **not** need to rebuild for normal development. Rebuild when at
least one of these applies:

- **Protocol / wire-format change upstream** that breaks compatibility
  with mainnet — would manifest as every etch failing. Monitor
  `github.com/WithAutonomi/ant-node` releases for chunk-protocol or
  payment-contract ABI changes.
- **Mainnet payment-contract address changes** — `BuildConfig.VAULT_ADDRESS`
  pin and the baked-in `ant-node` version both have to track.
- **Crossing the Merkle threshold** (≥ 64-chunk uploads ≈ ≥ 256 MiB).
  Not a concern for a text pastebin.
- **Pulling in upstream improvements** — new progress-reporting events,
  network-resilience fixes, etc.

## How to rebuild

Everything needed to rebuild from source is vendored in `ffi/`. There
are no sibling-checkout requirements and no floating deps.

### Prerequisites

| Tool | Version | Install |
| --- | --- | --- |
| Rust toolchain | `1.94.1` | pinned in `ffi/rust/rust-toolchain.toml`; `rustup` auto-installs on first build |
| Android targets | `aarch64-linux-android`, `x86_64-linux-android` | pinned in `rust-toolchain.toml` |
| `cargo-ndk` | `≥ 4.1` | `cargo install cargo-ndk` |
| `uniffi-bindgen` binary | `0.29.4` (must match `uniffi = "0.29.4"` in `ant-ffi/Cargo.toml`) | upstream has no published CLI crate — install from the uniffi-rs example: `cargo install --git https://github.com/mozilla/uniffi-rs --tag v0.29.4 --path examples/app/uniffi-bindgen-cli` (or clone locally then `cargo install --path <repo>/examples/app/uniffi-bindgen-cli`) |
| Android NDK | `27.0.12077973` | `~/Android/Sdk/ndk/27.0.12077973/` (SDK Manager or override with `ANDROID_NDK_HOME`) |
| `nm`, `diff` | host binutils | distro package manager |

### One-shot rebuild

```
scripts/build-ffi.sh             # build + verify (no app changes)
scripts/build-ffi.sh --swap      # build + verify + copy into app/
```

The script validates prerequisites, cross-compiles both `.so` targets,
regenerates the Kotlin bindings, and diffs exported FFI symbols against
the checked-in `app/src/main/jniLibs/arm64-v8a/SYMBOLS.reference.txt`. A
`--swap` that succeeds means the new artifacts are byte-compatible with
what the app expects — you still need to `./gradlew assembleDebug`,
install, and smoke-test before committing.

### What's pinned

| Pin | Where | Value |
| --- | --- | --- |
| `ant-core` | `ffi/rust/ant-ffi/Cargo.toml` | `git + rev = "6cada1d"` (ant-core v0.2.3, 2026-05-06) |
| `ant-node` | same | `= "0.11.1"` (mainnet release; pulls saorsa-core 0.24.2 transitively) |
| `evmlib` | same | `= "0.8.1"` |
| `self_encryption` | same | `= "0.35.0"` (needed for `get_root_data_map_parallel` in `data_get_public`/`data_get_private`) |
| `xor_name` | same | `= "5.0.0"` (transitive via `self_encryption`; promoted to direct dep so the `XorName` type in the hierarchical-resolver closure resolves) |
| `uniffi` | `ffi/rust/Cargo.toml` | `"0.29.4"` (workspace) |
| Rust | `rust-toolchain.toml` | `1.94.1` |
| NDK | `scripts/build-ffi.sh` | `27.0.12077973` |
| `cargo-ndk` | `scripts/build-ffi.sh` | `≥ 4.1` |

Bumping any pin: edit the relevant file, run `scripts/build-ffi.sh`,
expect the symbol diff to flag if the upgrade changes the FFI shape,
update this table in the same commit as the `.so` swap.

### Production-only

`ffi/` ships production-only:

- `Client::connect_local` is removed (was only for a local devnet this
  app never connects to).
- No `testnet-patches` feature — the upstream `#[cfg(feature = "testnet-patches")]`
  blocks (relaxed diversity caps, loopback enabled) are stripped.
- `Client::connect` uses `cli_style_client_config()` — stock concurrency
  with `store_timeout_secs: 60` to match what `ant-cli` does on the wire.

### Trim vs. upstream

`ffi/` is a trimmed copy of `WithAutonomi/ant-sdk@bf541cc`. Only
the FFI Rust crate is kept; the standalone `antd` daemon, other-language SDKs,
upstream CI, and docs are removed because nothing in this app
references them. See `ffi/README.md` for the exact list of pruned
directories.

**Behavior changes worth noting:**

- `#[uniffi::export]` removed from `ClientError::code()` /
  `WalletError::code()` — Kotlin doesn't call these.

## What's in `cli_style_client_config()` and why

The shipping FFI uses a small handful of overrides on top of stock
`ant-core` defaults to match what `ant-cli` does on the wire:

- `store_timeout_secs: 60` — `ant-cli` always overrides the default 10s
  to 60s via its `--store-timeout-secs` default. The 10s cap cuts off
  slow-but-reachable replicas before they can answer.
- `.ipv6(false)` on `CoreNodeConfig::builder()` — matches `ant-cli`.
  Cuts `Client::connect` from ~45s of doomed v4-mapped-in-v6 attempts
  to under a second.
- `.max_message_size(MAX_WIRE_MESSAGE_SIZE)` (5 MiB) — matches `ant-cli`.
  Stock saorsa-transport default is 1 MiB, which would silently drop
  any chunk response that crossed it.
- `resolve_data_map()` helper in `client.rs` that calls
  `self_encryption::get_root_data_map_parallel` before `data_download`
  in `data_get_public` / `data_get_private`. `ant-core`'s `data_download`
  does NOT resolve hierarchical (shrunk) DataMaps — for content large
  enough to need a tree of intermediate pointers, `data_map.infos()`
  returns the addresses of intermediate child-map chunks rather than
  the actual content. The helper resolves the hierarchy in-band the
  same way `ant-cli`'s `file_download_with_progress` does.
- `self_encryption` and `xor_name` are promoted to direct deps to make
  the resolver's closure types resolve.

The current pin (`ant-core@6cada1d`, `ant-node=0.11.1`) pulls in
saorsa-core 0.24.2's MASQUE relay support, so peers behind NAT advertise
relay addresses to the DHT and clients dial those first. This dramatically
reduces DIAL_TIMEOUT cascades on mobile / CGNAT.
