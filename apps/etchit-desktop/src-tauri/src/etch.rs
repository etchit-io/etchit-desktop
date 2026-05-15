//! Etch tab — turn user input into an `autonomi://` address.
//!
//! V0 wires the Tauri backend straight into `ant-ffi`: the wallet key
//! lives in the OS keychain, `Client::connect_with_wallet` brings up a
//! mainnet connection on Arbitrum One, then [`Client::data_put_public`]
//! (for text bytes) or [`Client::file_upload_public`] (for files)
//! returns the 64-hex address.
//!
//! The connected client is cached in [`EtchState`] keyed by SHA256 of
//! the wallet key, so the bootstrap warmup (~10 s) is paid once per
//! session. Rotating the key in Advanced invalidates the cache because
//! the fingerprint changes.
//!
//! Text uploads ship as **raw UTF-8 bytes** — no envelope, no metadata
//! wrapper. The same bytes uploaded from `ant-cli` or any other
//! Autonomi client land on the same address. Title is purely local
//! (stored in the History entry on this device).

use std::path::PathBuf;
use std::sync::Arc;

use ant_ffi::Client;
use sha2::{Digest, Sha256};
use tauri::State;
use tokio::sync::Mutex;

use crate::archive;
use crate::secrets;

const RPC_URL: &str = "https://arb1.arbitrum.io/rpc";
const ANT_TOKEN_ADDRESS: &str = "0xa78d8321B20c4Ef90eCd72f2588AA985A4BDb684";
const VAULT_ADDRESS: &str = "0x9A3EcAc693b699Fc0B2B6A50B5549e50c2320A26";

/// `ant-core`'s payment-mode selector. "auto" picks merkle for batches
/// of ≥ 2 chunks (cheaper gas) and per-chunk single payments below
/// that, which matches what `ant-cli` does by default.
pub(crate) const PAYMENT_MODE: &str = "auto";

const NO_KEY_HINT: &str =
    "no wallet key stored. paste a hex private key in Settings → Advanced first.";

/// Long-lived `Client` cache. The `Default` impl gives us an empty
/// cache; the first etch populates it.
///
/// Two slots, because the two wallet modes can't share a `Client`:
///
/// * `internal`: built via [`Client::connect_with_wallet`] using the
///   keychain key. Used by the existing `data_put_public` /
///   `file_upload_public` upload path. Cached by SHA256 fingerprint
///   of the key so rotating the key invalidates the entry.
/// * `external`: built via [`Client::connect`] with no wallet. Used
///   by the WalletConnect / external-signer flow — the user's wallet
///   pays for storage, the client only handles `prepare_public_upload`
///   and `finalize_public_upload`. Cached as a single instance per
///   process; no key fingerprint applies.
#[derive(Default)]
pub struct EtchState {
    cached: Mutex<Option<(Arc<Client>, [u8; 32])>>,
    pub(crate) external: Mutex<Option<Arc<Client>>>,
}

/// Upload raw text bytes as public data. The caller (frontend) keeps
/// any title or other metadata locally — the bytes on the network are
/// exactly what the user typed.
#[tauri::command]
pub async fn etch_text(
    state: State<'_, EtchState>,
    body: String,
) -> Result<String, String> {
    let client = get_or_build_client(&state).await?;
    let result = client
        .data_put_public(body.into_bytes(), PAYMENT_MODE.into())
        .await
        .map_err(|e| format!("upload failed: {e}"))?;
    Ok(result.address)
}

/// Upload a file as public data. Returns the 64-hex address.
#[tauri::command]
pub async fn etch_file(state: State<'_, EtchState>, path: String) -> Result<String, String> {
    let client = get_or_build_client(&state).await?;
    let result = client
        .file_upload_public(path, PAYMENT_MODE.into())
        .await
        .map_err(|e| format!("upload failed: {e}"))?;
    Ok(result.address)
}

/// Bundle two-or-more files (or one folder) into a ZIP and upload
/// that as public data. Returns the address of the archive. fetch>it
/// renders the archive index out of the box.
///
/// Single-file callers should use [`etch_file`] instead — it keeps
/// the bytes on the network byte-identical to the source, no archive
/// wrapper.
#[tauri::command]
pub async fn etch_files(
    state: State<'_, EtchState>,
    paths: Vec<String>,
) -> Result<String, String> {
    let path_bufs: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    let zip_bytes = archive::bundle_to_zip(&path_bufs)?;
    let client = get_or_build_client(&state).await?;
    let result = client
        .data_put_public(zip_bytes, PAYMENT_MODE.into())
        .await
        .map_err(|e| format!("upload failed: {e}"))?;
    Ok(result.address)
}

/// Build (or return cached) walletless client used by the external-signer
/// flow. No key required — the user signs the payment tx in their wallet.
pub(crate) async fn get_or_build_external_client(
    state: &EtchState,
) -> Result<Arc<Client>, String> {
    let mut guard = state.external.lock().await;
    if let Some(client) = guard.as_ref() {
        return Ok(client.clone());
    }
    let client = Client::connect(Vec::new())
        .await
        .map_err(|e| format!("client init failed: {e}"))?;
    *guard = Some(client.clone());
    Ok(client)
}

pub(crate) async fn get_or_build_client(state: &EtchState) -> Result<Arc<Client>, String> {
    let key = secrets::get_stored_key().ok_or_else(|| NO_KEY_HINT.to_string())?;
    let fp = key_fingerprint(&key);
    let mut guard = state.cached.lock().await;
    if let Some((client, cached_fp)) = guard.as_ref() {
        if cached_fp == &fp {
            return Ok(client.clone());
        }
    }
    // Either nothing cached or the user rotated the key — build fresh.
    let client = Client::connect_with_wallet(
        Vec::new(),
        key,
        RPC_URL.to_string(),
        ANT_TOKEN_ADDRESS.to_string(),
        VAULT_ADDRESS.to_string(),
    )
    .await
    .map_err(|e| format!("client init failed: {e}"))?;
    *guard = Some((client.clone(), fp));
    Ok(client)
}

fn key_fingerprint(key: &str) -> [u8; 32] {
    Sha256::digest(key.as_bytes()).into()
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    const KEY_A: &str = "f4b86ae19e4b1e625ea2af9b15015340443988407f0ae56d28a1050e64ece167";
    const KEY_B: &str = "f4b86ae19e4b1e625ea2af9b15015340443988407f0ae56d28a1050e64ece168";

    #[test]
    fn fingerprint_is_deterministic() {
        assert_eq!(key_fingerprint(KEY_A), key_fingerprint(KEY_A));
    }

    #[test]
    fn fingerprint_differs_by_key() {
        assert_ne!(key_fingerprint(KEY_A), key_fingerprint(KEY_B));
    }
}
