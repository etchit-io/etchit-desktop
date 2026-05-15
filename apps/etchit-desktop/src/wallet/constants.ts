// EVM constants. Must match the Rust side (`src-tauri/src/wallet.rs`)
// and the Android build (`etchit-android/app/build.gradle.kts`) — the
// three clients share a chain, token, and payment vault.

/** Arbitrum One JSON-RPC endpoint. */
export const ARBITRUM_RPC = "https://arb1.arbitrum.io/rpc";

/** Arbitrum One chain id. */
export const ARBITRUM_CHAIN_ID = 42161;

/** ANT (Autonomi Network Token) ERC-20 contract on Arbitrum One. */
export const ANT_TOKEN_ADDRESS = "0xa78d8321B20c4Ef90eCd72f2588AA985A4BDb684";

/** Autonomi payment vault contract on Arbitrum One. The vault holds
 *  per-quote payments before they're released to chunk-holders. */
export const VAULT_ADDRESS = "0x9A3EcAc693b699Fc0B2B6A50B5549e50c2320A26";

/** One-time ANT approval the external-signer flow requests. 20 ANT
 *  in atto units. Matches the old desktop; users only approve once
 *  per session, every etch under this ceiling skips the approve tx. */
export const SESSION_BUDGET_ATTO = 20_000_000_000_000_000_000n;

/** Reown AppKit project id. Same one the old desktop and Android app
 *  ship — not a secret (visible in any JS bundle / APK BuildConfig). */
export const REOWN_PROJECT_ID = "aebccdd6a244efb2ca596326f00b90d2";
