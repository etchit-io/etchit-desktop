# ffi (vendored from ant-sdk)

Trimmed vendored copy of [WithAutonomi/ant-sdk](https://github.com/WithAutonomi/ant-sdk),
kept only because we apply local patches to the Rust FFI crate under
`rust/ant-ffi/`. Built into `libant_ffi.so` by `scripts/build-ffi.sh`.

## What's here

- `rust/` — the `ant-ffi` Cargo workspace. This is what
  `scripts/build-ffi.sh` compiles into `libant_ffi.so`.
- `.reference-source/` — preserved snapshot of the upstream FFI source
  the original shipping `libant_ffi.so` was built from. Read-only. Used
  for diff-vs-upstream when future upgrades are considered.
- `.gitignore` — excludes Cargo `target/` output.

## What was removed vs. upstream

The following upstream directories were pruned because nothing in this
app's build path references them:

- `antd/`, `antd-cli/` (standalone daemon)
- `antd-{cpp,csharp,dart,elixir,go,java,js,kotlin,lua,mcp,php,py,ruby,rust,swift,zig}/`
  (non-Rust language SDKs for the daemon)
- `ffi/{csharp,kotlin,scripts,swift}/` (other-target bindings + upstream build scripts)
- `docs/`, top-level `README.md`, `llms*.txt`, `skill.md`, `.github/`

If upstream tooling or bindings are ever needed, clone the full
upstream separately rather than re-vendoring them here.

## Local patches vs. upstream

Upstream reference point: `WithAutonomi/ant-sdk@bf541cc` (as of vendoring
on 2026-04-21). Our diffs live in `rust/ant-ffi/src/` and
`rust/ant-ffi/Cargo.toml`. The main deltas:

- `Client::prepare_public_upload`, `Client::finalize_public_upload`,
  `Client::peer_count` added.
- `Client::connect_local` removed (local-devnet only, unused).
- `testnet-patches` Cargo feature removed entirely (production-only).
- `start_node_with_warmup()` helper for faster connect; `cli_style_client_config()`
  matches `ant-cli` wire defaults (60s store timeout, IPv4-only, 5 MiB max
  wire message). The earlier `mobile_client_config()` was dropped in favor
  of this — the cli-style config gets the same connect-time wins without
  diverging from `ant-cli` behavior.
- `self_encryption` and `xor_name` promoted to direct deps so the
  hierarchical-DataMap resolver in `data_get_public` / `data_get_private`
  (calls `get_root_data_map_parallel` before `data_download`) compiles.
- `ant-core` pinned as `git + rev = "6cada1d"` (v0.2.3); `ant-node = "=0.11.1"`;
  `evmlib = "=0.8.1"`; `self_encryption = "=0.35.0"`; `xor_name = "=5.0.0"`.
  This pin pulls in saorsa-core 0.24.2's MASQUE relay support — peers
  behind NAT advertise relay addresses so clients dial those first,
  cutting DIAL_TIMEOUT cascades on mobile / CGNAT.

Full rebuild / upgrade instructions: [`../docs/FFI_BUILD.md`](../docs/FFI_BUILD.md).
