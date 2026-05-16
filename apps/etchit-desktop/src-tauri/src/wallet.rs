//! Wallet tab + external-signer bridge.
//!
//! Two responsibilities:
//!
//! 1. **Internal-mode info**: derive the Ethereum address from the
//!    keychain key and query its ANT + ETH balance on Arbitrum One. The
//!    key never leaves Rust — the FE only ever sees the address and the
//!    balances. Mirrors how `etchit-android` surfaces wallet state.
//!
//! 2. **External-signer upload bridge**: `prepare_public_etch` /
//!    `finalize_public_etch` wrap ant-ffi's `prepare_public_upload`
//!    and `finalize_public_upload`. The frontend runs the two halves
//!    around a wallet round-trip (approve + payForQuotes on the
//!    Vault), mirroring the upload pipeline in `etchit-desktop-old`
//!    (which proved the AppKit-in-Tauri-WebView path).
//!
//! Both halves share the same upload pipeline as Etch / Blogger /
//! Website — frontend chooses the mode, Rust just exposes both.
//!
//! Constants (RPC, token, vault, network IDs) are deliberately kept
//! the same as `etch.rs` + the old desktop so cross-client behaviour
//! is identical to Android.

use std::collections::HashMap;

use ant_ffi::Wallet;
use serde::Serialize;
use tauri::State;

use crate::etch::{self, EtchState};
use crate::secrets;

const RPC_URL: &str = "https://arb1.arbitrum.io/rpc";
const ANT_TOKEN_ADDRESS: &str = "0xa78d8321B20c4Ef90eCd72f2588AA985A4BDb684";
const VAULT_ADDRESS: &str = "0x9A3EcAc693b699Fc0B2B6A50B5549e50c2320A26";

/// Internal-wallet snapshot returned to the Wallet tab.
#[derive(Serialize)]
pub struct InternalWalletInfo {
    /// 0x-prefixed lowercase hex.
    pub address: String,
    /// ANT balance as a decimal string of atto-ANT (18 decimals).
    pub ant_atto: String,
    /// ETH balance as a decimal string of wei.
    pub eth_wei: String,
}

/// Just the derived Ethereum address — no balance queries. Cheap and
/// network-free. Use this when you only need to identify the wallet
/// (e.g. risk checks, displaying the address); use
/// [`internal_wallet_info`] when you also need ANT/ETH balances.
#[tauri::command]
pub fn internal_wallet_address() -> Result<Option<String>, String> {
    let Some(key) = secrets::get_stored_key() else {
        return Ok(None);
    };
    let wallet = Wallet::from_private_key(
        key,
        RPC_URL.into(),
        ANT_TOKEN_ADDRESS.into(),
        VAULT_ADDRESS.into(),
    )
    .map_err(|e| format!("wallet build failed: {e}"))?;
    Ok(Some(wallet.address()))
}

/// Read the keychain key, build a wallet, return address + balances.
/// Returns `Ok(None)` when no key is stored; `Err` only on RPC / parse
/// failures. The wallet object is constructed fresh and dropped at the
/// end of the call so the key never lingers in process memory after
/// the balance query completes.
#[tauri::command]
pub async fn internal_wallet_info() -> Result<Option<InternalWalletInfo>, String> {
    let Some(key) = secrets::get_stored_key() else {
        return Ok(None);
    };
    let wallet = Wallet::from_private_key(
        key,
        RPC_URL.into(),
        ANT_TOKEN_ADDRESS.into(),
        VAULT_ADDRESS.into(),
    )
    .map_err(|e| format!("wallet build failed: {e}"))?;
    let address = wallet.address();
    let ant_atto = wallet
        .balance_of_tokens()
        .await
        .map_err(|e| format!("ANT balance query failed: {e}"))?;
    let eth_wei = wallet
        .balance_of_gas_tokens()
        .await
        .map_err(|e| format!("ETH balance query failed: {e}"))?;
    Ok(Some(InternalWalletInfo {
        address,
        ant_atto,
        eth_wei,
    }))
}

/// One payment line item the wallet must sign over (forwarded as-is
/// from ant-ffi). Hex strings with no `0x` prefix; the frontend adds
/// the prefix before encoding the `payForQuotes` calldata.
///
/// Shared with `private_etch` since both paths return the same
/// payment shape — the only difference is whether the prepare result
/// carries a data-map.
#[derive(Serialize)]
pub struct PaymentDto {
    pub rewards_address: String,
    pub amount: String,
    pub quote_hash: String,
}

/// Output of [`prepare_public_etch`]: a transient `upload_id` plus the
/// payment vector the wallet has to sign.
#[derive(Serialize)]
pub struct PreparedPublicEtch {
    pub upload_id: String,
    pub payments: Vec<PaymentDto>,
    /// Sum across `payments`, decimal string of atto-ANT.
    pub total_amount: String,
}

/// Result of [`finalize_public_etch`].
#[derive(Serialize)]
pub struct PublicEtchResult {
    pub address: String,
    pub chunks_stored: u64,
}

/// First half of the external-signer upload. Returns the `upload_id`
/// the caller passes to [`finalize_public_etch`] after the on-chain
/// payment confirms.
#[tauri::command]
pub async fn prepare_public_etch(
    state: State<'_, EtchState>,
    data: Vec<u8>,
) -> Result<PreparedPublicEtch, String> {
    let client = etch::get_or_build_external_client(&state).await?;
    prepare_from_bytes(&client, data).await
}

/// Text variant: ships the raw UTF-8 body bytes. Mirrors the
/// internal-mode path one-to-one — bytes on the network are exactly
/// what the user typed, no metadata wrapper.
#[tauri::command]
pub async fn prepare_public_etch_text(
    state: State<'_, EtchState>,
    body: String,
) -> Result<PreparedPublicEtch, String> {
    let client = etch::get_or_build_external_client(&state).await?;
    prepare_from_bytes(&client, body.into_bytes()).await
}

/// File variant: read the file in Rust and feed the bytes to ant-ffi's
/// `prepare_public_upload`. Avoids a megabyte-grade round-trip across
/// the Tauri IPC just to push the same bytes back into Rust.
#[tauri::command]
pub async fn prepare_public_etch_file(
    state: State<'_, EtchState>,
    path: String,
) -> Result<PreparedPublicEtch, String> {
    let client = etch::get_or_build_external_client(&state).await?;
    let bytes =
        std::fs::read(&path).map_err(|e| format!("couldn't read {path}: {e}"))?;
    prepare_from_bytes(&client, bytes).await
}

/// Multi-file variant: bundles the paths into a ZIP archive
/// (no compression — see `archive::bundle_to_zip`) and prepares the
/// upload as public data. The frontend pumps the wallet through the
/// same approve / payForQuotes pipeline as a single file etch.
#[tauri::command]
pub async fn prepare_public_etch_files(
    state: State<'_, EtchState>,
    paths: Vec<String>,
) -> Result<PreparedPublicEtch, String> {
    let client = etch::get_or_build_external_client(&state).await?;
    let path_bufs: Vec<std::path::PathBuf> = paths.into_iter().map(Into::into).collect();
    let bytes = crate::archive::bundle_to_zip(&path_bufs)?;
    prepare_from_bytes(&client, bytes).await
}

async fn prepare_from_bytes(
    client: &ant_ffi::Client,
    data: Vec<u8>,
) -> Result<PreparedPublicEtch, String> {
    let prep = client
        .prepare_public_upload(data)
        .await
        .map_err(|e| format!("prepare failed: {e}"))?;
    Ok(PreparedPublicEtch {
        upload_id: prep.upload_id,
        payments: prep
            .payments
            .into_iter()
            .map(|p| PaymentDto {
                rewards_address: p.rewards_address,
                amount: p.amount,
                quote_hash: p.quote_hash,
            })
            .collect(),
        total_amount: prep.total_amount,
    })
}

/// Second half of the external-signer upload. `tx_hashes` maps each
/// quote hash (from the prepared payment vector) to the `payForQuotes`
/// transaction hash the wallet signed. ant-core verifies the tx hashes
/// before committing the chunks.
#[tauri::command]
pub async fn finalize_public_etch(
    state: State<'_, EtchState>,
    upload_id: String,
    tx_hashes: HashMap<String, String>,
) -> Result<PublicEtchResult, String> {
    let client = etch::get_or_build_external_client(&state).await?;
    let res = client
        .finalize_public_upload(upload_id, tx_hashes)
        .await
        .map_err(|e| format!("finalize failed: {e}"))?;
    Ok(PublicEtchResult {
        address: res.address,
        chunks_stored: res.chunks_stored,
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn constants_match_old_desktop_and_android() {
        // These three are part of the cross-client EVM contract — same
        // chain, same token, same vault — so etchit-desktop, the old
        // desktop, and the Android app all transact identically.
        assert_eq!(RPC_URL, "https://arb1.arbitrum.io/rpc");
        assert_eq!(ANT_TOKEN_ADDRESS, "0xa78d8321B20c4Ef90eCd72f2588AA985A4BDb684");
        assert_eq!(VAULT_ADDRESS, "0x9A3EcAc693b699Fc0B2B6A50B5549e50c2320A26");
    }

    #[test]
    fn dto_serializes_to_camel_case_keys_the_frontend_expects() {
        let dto = PaymentDto {
            rewards_address: "abc".into(),
            amount: "1".into(),
            quote_hash: "def".into(),
        };
        let s = serde_json::to_string(&dto).unwrap();
        // serde default = field-name verbatim, which matches the
        // frontend's `PaymentDto` interface.
        assert!(s.contains("\"rewards_address\":\"abc\""));
        assert!(s.contains("\"amount\":\"1\""));
        assert!(s.contains("\"quote_hash\":\"def\""));
    }
}
