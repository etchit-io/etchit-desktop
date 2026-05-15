//! Private etches — encrypted Autonomi uploads.
//!
//! Where a *public* etch produces a globally-readable address, a
//! *private* etch produces an opaque chunk wall plus a data-map. The
//! data-map is the only key — anyone with it can decrypt, anyone
//! without it can't. The data-map stays on this device; the chunks
//! live on the network.
//!
//! Two upload paths, mirroring the public surface:
//!
//! * **Internal**: `private_etch_internal_text` reuses the cached
//!   wallet-bearing `Client` to call `data_put_private` directly — the
//!   wallet handles approve + payForQuotes internally, returns the
//!   data-map in one shot.
//! * **External**: `prepare_private_etch` + `finalize_private_etch`
//!   wrap ant-ffi's `prepare_data_upload` / `finalize_upload`. The
//!   frontend pumps the wallet through the same approve / payForQuotes
//!   pipeline as the public flow; the only difference is the prepare
//!   returns a `data_map` to keep.
//!
//! Retrieval (`fetch_private`) works the same regardless of how the
//! data was uploaded — read is free, hand the saved data-map back to
//! `data_get_private`.

use std::collections::HashMap;

use serde::Serialize;
use tauri::State;

use crate::etch::{self, EtchState};
use crate::wallet::PaymentDto;

/// Output of [`prepare_private_etch`]. Same shape as the public
/// equivalent except for `data_map`, which the caller must persist —
/// without it the uploaded chunks are unreachable.
#[derive(Serialize)]
pub struct PreparedPrivateEtch {
    pub upload_id: String,
    pub payments: Vec<PaymentDto>,
    /// Sum across `payments`, decimal string of atto-ANT.
    pub total_amount: String,
    /// Hex-encoded serialized data-map. Caller persists it locally.
    pub data_map: String,
}

/// Result of [`finalize_private_etch`]. The "address" of a private
/// etch is its data-map (returned by [`prepare_private_etch`]); this
/// step only reports how many chunks landed.
#[derive(Serialize)]
pub struct PrivateEtchResult {
    pub chunks_stored: u64,
}

/// Internal-mode private etch: single-shot upload via the cached
/// wallet-bearing client. Returns the data-map for local persistence
/// and the chunk count for the user's confirmation.
#[derive(Serialize)]
pub struct InternalPrivateResult {
    pub data_map: String,
    pub chunks_stored: u64,
}

/// First half of the external-signer private upload (in-memory bytes
/// — used by the text path). Returns `upload_id` + `payments` (same
/// as the public flow) plus the `data_map`.
#[tauri::command]
pub async fn prepare_private_etch(
    state: State<'_, EtchState>,
    data: Vec<u8>,
) -> Result<PreparedPrivateEtch, String> {
    let client = etch::get_or_build_external_client(&state).await?;
    let prep = client
        .prepare_data_upload(data)
        .await
        .map_err(|e| format!("prepare failed: {e}"))?;
    Ok(shape(prep))
}

/// Prepare a private file upload by path — uses ant-ffi's
/// `prepare_file_upload`, which streams from disk rather than
/// requiring a `Vec<u8>` round-trip across the IPC.
#[tauri::command]
pub async fn prepare_private_etch_file(
    state: State<'_, EtchState>,
    path: String,
) -> Result<PreparedPrivateEtch, String> {
    let client = etch::get_or_build_external_client(&state).await?;
    let prep = client
        .prepare_file_upload(path)
        .await
        .map_err(|e| format!("prepare failed: {e}"))?;
    Ok(shape(prep))
}

/// Prepare a multi-file private upload: bundles the paths into a ZIP
/// (no compression) and feeds the in-memory bytes to ant-ffi's
/// `prepare_data_upload`.
#[tauri::command]
pub async fn prepare_private_etch_files(
    state: State<'_, EtchState>,
    paths: Vec<String>,
) -> Result<PreparedPrivateEtch, String> {
    let client = etch::get_or_build_external_client(&state).await?;
    let path_bufs: Vec<std::path::PathBuf> = paths.into_iter().map(Into::into).collect();
    let bytes = crate::archive::bundle_to_zip(&path_bufs)?;
    let prep = client
        .prepare_data_upload(bytes)
        .await
        .map_err(|e| format!("prepare failed: {e}"))?;
    Ok(shape(prep))
}

fn shape(prep: ant_ffi::PrepareUploadResult) -> PreparedPrivateEtch {
    PreparedPrivateEtch {
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
        data_map: prep.data_map,
    }
}

/// Second half of the external-signer private upload. The data-map
/// was already handed back at prepare time; this step just confirms
/// the chunks landed.
#[tauri::command]
pub async fn finalize_private_etch(
    state: State<'_, EtchState>,
    upload_id: String,
    tx_hashes: HashMap<String, String>,
) -> Result<PrivateEtchResult, String> {
    let client = etch::get_or_build_external_client(&state).await?;
    let res = client
        .finalize_upload(upload_id, tx_hashes)
        .await
        .map_err(|e| format!("finalize failed: {e}"))?;
    Ok(PrivateEtchResult {
        chunks_stored: res.chunks_stored,
    })
}

/// Internal-mode private etch. Ships the raw UTF-8 body bytes via
/// the cached wallet-bearing client. Title (if any) is local-only
/// metadata stored on the caller side. Wallet pays internally;
/// data-map returned for local persistence.
#[tauri::command]
pub async fn private_etch_internal_text(
    state: State<'_, EtchState>,
    body: String,
) -> Result<InternalPrivateResult, String> {
    let client = etch::get_or_build_client(&state).await?;
    let result = client
        .data_put_private(body.into_bytes(), etch::PAYMENT_MODE.into())
        .await
        .map_err(|e| format!("upload failed: {e}"))?;
    Ok(InternalPrivateResult {
        data_map: result.data_map,
        chunks_stored: result.chunks_stored,
    })
}

/// Internal-mode private file etch. Reads the file in Rust and ships
/// via `data_put_private` on the cached wallet-bearing client. For
/// very large files this loads the whole payload into memory — fine
/// for typical "private notes" / small attachments; revisit when the
/// product grows file-set use cases.
#[tauri::command]
pub async fn private_etch_internal_file(
    state: State<'_, EtchState>,
    path: String,
) -> Result<InternalPrivateResult, String> {
    let client = etch::get_or_build_client(&state).await?;
    let bytes =
        std::fs::read(&path).map_err(|e| format!("couldn't read {path}: {e}"))?;
    let result = client
        .data_put_private(bytes, etch::PAYMENT_MODE.into())
        .await
        .map_err(|e| format!("upload failed: {e}"))?;
    Ok(InternalPrivateResult {
        data_map: result.data_map,
        chunks_stored: result.chunks_stored,
    })
}

/// Internal-mode private multi-file etch. Bundles the paths into a
/// ZIP (no compression) and ships the archive via `data_put_private`.
/// One data-map covers the whole set.
#[tauri::command]
pub async fn private_etch_internal_files(
    state: State<'_, EtchState>,
    paths: Vec<String>,
) -> Result<InternalPrivateResult, String> {
    let client = etch::get_or_build_client(&state).await?;
    let path_bufs: Vec<std::path::PathBuf> = paths.into_iter().map(Into::into).collect();
    let bytes = crate::archive::bundle_to_zip(&path_bufs)?;
    let result = client
        .data_put_private(bytes, etch::PAYMENT_MODE.into())
        .await
        .map_err(|e| format!("upload failed: {e}"))?;
    Ok(InternalPrivateResult {
        data_map: result.data_map,
        chunks_stored: result.chunks_stored,
    })
}

/// Read-only fetch. Independent of wallet mode — the data-map alone
/// is enough. Returns the original bytes.
#[tauri::command]
pub async fn fetch_private_data(
    state: State<'_, EtchState>,
    data_map_hex: String,
) -> Result<Vec<u8>, String> {
    // Read uses the walletless client too — no wallet needed for
    // private fetches, just like public.
    let client = etch::get_or_build_external_client(&state).await?;
    client
        .data_get_private(data_map_hex)
        .await
        .map_err(|e| format!("fetch failed: {e}"))
}

/// Write previously-fetched private bytes to disk. The Tauri save
/// dialog runs frontend-side; this command just writes the bytes the
/// user already has (returned by `fetch_private_data`).
#[tauri::command]
pub fn save_bytes_to_path(path: String, data: Vec<u8>) -> Result<(), String> {
    std::fs::write(&path, &data).map_err(|e| format!("couldn't write {path}: {e}"))
}

/// Get a file's size in bytes. Used by the Etch / Private tabs to
/// display "filename · 2.4 MB" before uploading. Returns `0` for any
/// read failure or for directories — the caller treats absence of
/// size as a non-fatal display fallback, not an error.
#[tauri::command]
pub fn file_size(path: String) -> u64 {
    std::fs::metadata(&path)
        .map(|m| if m.is_file() { m.len() } else { 0 })
        .unwrap_or(0)
}

/// Whether the path is a directory. Used by the file-mode dispatch
/// to decide between a raw single-file upload and a ZIP-bundle.
/// Returns `false` for non-existent paths.
#[tauri::command]
pub fn is_directory(path: String) -> bool {
    std::fs::metadata(&path).map(|m| m.is_dir()).unwrap_or(false)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn dto_field_names_match_frontend_contract() {
        let p = PreparedPrivateEtch {
            upload_id: "u".into(),
            payments: vec![],
            total_amount: "0".into(),
            data_map: "abcd".into(),
        };
        let s = serde_json::to_string(&p).unwrap();
        // Frontend reads these exact keys.
        assert!(s.contains("\"upload_id\""));
        assert!(s.contains("\"payments\""));
        assert!(s.contains("\"total_amount\""));
        assert!(s.contains("\"data_map\""));
    }
}
