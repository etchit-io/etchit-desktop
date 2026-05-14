//! Etch tab — turn user input into an `autonomi://` address.
//!
//! V0 wires the Tauri backend straight into `ant-ffi`: the wallet key
//! lives in the OS keychain, `Client::connect_with_wallet` brings up a
//! mainnet connection on Arbitrum One, then [`Client::data_put_public`]
//! (for text envelopes) or [`Client::file_upload_public`] (for files)
//! returns the 64-hex address.
//!
//! The connected client is cached in [`EtchState`] keyed by SHA256 of
//! the wallet key, so the bootstrap warmup (~10 s) is paid once per
//! session. Rotating the key in Advanced invalidates the cache because
//! the fingerprint changes.
//!
//! Envelope shape matches Android (`PasteUtils.kt`) so fetch>it's
//! `EtchitEnvelopeHandler` recognises text etches. No etch/it strings
//! ever land in the uploaded bytes — see `docs/upload-neutrality.md`.

use std::sync::Arc;

use ant_ffi::Client;
use sha2::{Digest, Sha256};
use tauri::State;
use tokio::sync::Mutex;

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
#[derive(Default)]
pub struct EtchState {
    cached: Mutex<Option<(Arc<Client>, [u8; 32])>>,
}

/// Wrap `title` + `body` in the etch/it envelope JSON and upload as
/// public data. Returns the 64-hex address.
#[tauri::command]
pub async fn etch_text(
    state: State<'_, EtchState>,
    title: String,
    body: String,
) -> Result<String, String> {
    let envelope = build_envelope(&title, &body);
    let client = get_or_build_client(&state).await?;
    let result = client
        .data_put_public(envelope.into_bytes(), PAYMENT_MODE.into())
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

fn build_envelope(title: &str, body: &str) -> String {
    let t = serde_json::to_string(title.trim()).unwrap_or_else(|_| "\"\"".into());
    let b = serde_json::to_string(body).unwrap_or_else(|_| "\"\"".into());
    format!(r#"{{"v":1,"meta":{{"title":{t},"lang":""}},"content":{b}}}"#)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    const KEY_A: &str = "f4b86ae19e4b1e625ea2af9b15015340443988407f0ae56d28a1050e64ece167";
    const KEY_B: &str = "f4b86ae19e4b1e625ea2af9b15015340443988407f0ae56d28a1050e64ece168";

    #[test]
    fn envelope_matches_android_shape() {
        let s = build_envelope("Hello", "world");
        assert_eq!(
            s,
            r#"{"v":1,"meta":{"title":"Hello","lang":""},"content":"world"}"#
        );
    }

    #[test]
    fn envelope_escapes_specials() {
        let s = build_envelope("a\"b", "c\\d\ne");
        let parsed: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert_eq!(parsed["meta"]["title"], "a\"b");
        assert_eq!(parsed["content"], "c\\d\ne");
    }

    #[test]
    fn envelope_trims_title_only() {
        let s = build_envelope("  trim  ", "  keep  ");
        let parsed: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert_eq!(parsed["meta"]["title"], "trim");
        assert_eq!(parsed["content"], "  keep  ");
    }

    #[test]
    fn envelope_carries_no_brand_string() {
        let s = build_envelope("anything", "any body");
        let lower = s.to_lowercase();
        for forbidden in ["etchit", "etch/it", "etch>it", "etchit.io"] {
            assert!(
                !lower.contains(forbidden),
                "envelope must not contain {forbidden}"
            );
        }
    }

    #[test]
    fn fingerprint_is_deterministic() {
        assert_eq!(key_fingerprint(KEY_A), key_fingerprint(KEY_A));
    }

    #[test]
    fn fingerprint_differs_by_key() {
        assert_ne!(key_fingerprint(KEY_A), key_fingerprint(KEY_B));
    }
}
