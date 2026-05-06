#!/usr/bin/env bash
#
# build-ffi.sh — rebuild libant_ffi.so from source and verify against the
# currently-shipping binary.
#
# Usage:
#   scripts/build-ffi.sh            # build + verify only
#   scripts/build-ffi.sh --swap     # build, verify, then copy into app/
#
# Environment:
#   ANDROID_NDK_HOME   path to NDK r27 (default: ~/Android/Sdk/ndk/27.0.12077973)
#
# Exit codes:
#   0  all checks passed
#   1  missing prerequisite
#   2  build failed
#   3  symbol or binding diff unexpected — review before swap

set -euo pipefail

# --- config ------------------------------------------------------------------

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FFI_DIR="$REPO_ROOT/ffi/rust"
JNI_DIR="$REPO_ROOT/app/src/main/jniLibs"
BINDINGS_DST="$REPO_ROOT/app/src/main/java/uniffi/ant_ffi/ant_ffi.kt"
SYMBOLS_REF="$JNI_DIR/arm64-v8a/SYMBOLS.reference.txt"

# Pinned versions the current shipping .so was built with. Bump deliberately;
# update docs/FFI_BUILD.md in the same commit as any pin change.
RUST_EXPECTED="1.94.1"
CARGO_NDK_MIN="4.1"
NDK_EXPECTED_VERSION="27.0.12077973"
NDK_HOME="${ANDROID_NDK_HOME:-$HOME/Android/Sdk/ndk/$NDK_EXPECTED_VERSION}"
NDK_PLATFORM="26"

SWAP=0
[[ "${1:-}" == "--swap" ]] && SWAP=1

# --- helpers -----------------------------------------------------------------

fail() { echo "ERROR: $*" >&2; exit "${2:-1}"; }
note() { echo "==> $*"; }
warn() { echo "WARN: $*" >&2; }

have() { command -v "$1" >/dev/null 2>&1; }

# --- phase 1: prerequisites --------------------------------------------------

note "Checking prerequisites"

have rustc || fail "rustc not found. Install via https://rustup.rs"
RUST_VERSION="$(rustc --version | awk '{print $2}')"
if [[ "$RUST_VERSION" != "$RUST_EXPECTED" ]]; then
  warn "rustc is $RUST_VERSION, expected $RUST_EXPECTED. Build will likely still succeed but the .so may not byte-for-byte match the shipping one."
fi

have cargo || fail "cargo not found (comes with rustup)"

for target in aarch64-linux-android x86_64-linux-android; do
  if ! rustup target list --installed | grep -q "^$target$"; then
    fail "missing Rust target $target. Install: rustup target add $target"
  fi
done

have cargo-ndk || fail "cargo-ndk not found. Install: cargo install cargo-ndk"
CARGO_NDK_VERSION="$(cargo ndk --version | awk '{print $2}')"
# shellcheck disable=SC2072  # string version compare is fine for our pin
if [[ "$CARGO_NDK_VERSION" < "$CARGO_NDK_MIN" ]]; then
  fail "cargo-ndk $CARGO_NDK_VERSION is older than $CARGO_NDK_MIN. Upgrade: cargo install cargo-ndk"
fi

if [[ ! -d "$NDK_HOME" ]]; then
  fail "Android NDK not found at $NDK_HOME. Install NDK $NDK_EXPECTED_VERSION via SDK manager or set ANDROID_NDK_HOME."
fi
export ANDROID_NDK_HOME="$NDK_HOME"

have uniffi-bindgen || fail "uniffi-bindgen not found. Install (matching the uniffi version in ant-ffi/Cargo.toml — currently 0.29.4):
  cargo install --git https://github.com/mozilla/uniffi-rs --tag v0.29.4 --path examples/app/uniffi-bindgen-cli
The uniffi-bindgen-cli crate is not published to crates.io."

have nm || fail "nm not found (binutils). Install: apt install binutils"

# --- phase 2: build ----------------------------------------------------------

note "Building libant_ffi.so for arm64-v8a and x86_64 (release, platform $NDK_PLATFORM)"
(
  cd "$FFI_DIR"
  cargo ndk --platform "$NDK_PLATFORM" -t arm64-v8a -t x86_64 build --release -p ant-ffi
) || fail "cargo ndk build failed" 2

ARM64_SO="$FFI_DIR/target/aarch64-linux-android/release/libant_ffi.so"
X86_64_SO="$FFI_DIR/target/x86_64-linux-android/release/libant_ffi.so"

[[ -f "$ARM64_SO" ]] || fail "arm64-v8a output missing: $ARM64_SO" 2
[[ -f "$X86_64_SO" ]] || fail "x86_64 output missing: $X86_64_SO" 2

note "Output sizes:"
ls -lh "$ARM64_SO" "$X86_64_SO" | awk '{printf "    %s  %s\n", $5, $9}'

# --- phase 3: verify symbols --------------------------------------------------

note "Diffing exported FFI symbols against $SYMBOLS_REF"

NEW_SYMBOLS="$(mktemp)"
trap 'rm -f "$NEW_SYMBOLS"' EXIT

nm -D --defined-only "$ARM64_SO" \
  | grep -E 'ant_ffi_fn|uniffi_ant_ffi' \
  | awk '{print $NF}' \
  | sort > "$NEW_SYMBOLS"

NEW_COUNT=$(wc -l < "$NEW_SYMBOLS")
REF_COUNT=$(wc -l < "$SYMBOLS_REF")

if ! diff -q "$SYMBOLS_REF" "$NEW_SYMBOLS" >/dev/null; then
  echo "symbol diff (reference -> new):"
  diff "$SYMBOLS_REF" "$NEW_SYMBOLS" | sed 's/^/    /'
  fail "symbol table differs from $SYMBOLS_REF. If this is intentional, update the reference file in the same commit as the swap." 3
fi

note "Symbols match: $NEW_COUNT exports, identical to reference"

# --- phase 4: regenerate bindings -------------------------------------------

note "Regenerating Kotlin bindings"
SCRATCH_DIR="$(mktemp -d)"
trap 'rm -f "$NEW_SYMBOLS"; rm -rf "$SCRATCH_DIR"' EXIT

(
  cd "$FFI_DIR"
  uniffi-bindgen generate \
    --library "$ARM64_SO" \
    --language kotlin \
    --out-dir "$SCRATCH_DIR"
) 2>&1 | grep -v "Unable to auto-format.*ktlint" || true

NEW_BINDINGS="$SCRATCH_DIR/uniffi/ant_ffi/ant_ffi.kt"
[[ -f "$NEW_BINDINGS" ]] || fail "uniffi-bindgen produced no output" 2

# Filter-diff the bindings: internal checksum constants shift on every
# build even when the FFI contract is unchanged, and KDoc text changes
# (propagated from Rust doc comments) aren't structural — strip both so
# we only fail on real shape changes.
BINDING_DIFF="$(mktemp)"
trap 'rm -f "$NEW_SYMBOLS" "$BINDING_DIFF"; rm -rf "$SCRATCH_DIR"' EXIT

diff -u "$BINDINGS_DST" "$NEW_BINDINGS" \
  | grep -E '^[-+][^-+]' \
  | grep -vE 'checksum|toShort\(\)|^[-+][[:space:]]*\*' > "$BINDING_DIFF" || true

if [[ -s "$BINDING_DIFF" ]]; then
  echo "binding structural diff (existing -> new):"
  head -50 "$BINDING_DIFF" | sed 's/^/    /'
  fail "regenerated bindings differ in shape. Review before swap." 3
fi

note "Bindings match: only internal checksum lines differ (expected)"

# --- phase 5: swap (gated) --------------------------------------------------

if [[ $SWAP -eq 1 ]]; then
  note "Swapping new .so files + bindings into app/"
  cp "$ARM64_SO"  "$JNI_DIR/arm64-v8a/libant_ffi.so"
  cp "$X86_64_SO" "$JNI_DIR/x86_64/libant_ffi.so"
  cp "$NEW_BINDINGS" "$BINDINGS_DST"
  # Refresh symbol reference so future diffs stay honest
  cp "$NEW_SYMBOLS" "$SYMBOLS_REF"
  note "Swap complete. Next:"
  echo "    ./gradlew clean assembleDebug   # verify Kotlin still compiles"
  echo "    # install the APK and smoke-test before committing"
  echo "    git diff --stat app/"
else
  note "Dry run complete. Re-run with --swap to copy the new .so + bindings into app/"
fi
