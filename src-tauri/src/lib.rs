use std::collections::HashMap;
use std::sync::Arc;
use serde::Serialize;
use tauri::State;
use tokio::sync::Mutex;

struct AppState {
    client: Mutex<Option<Arc<ant_ffi::Client>>>,
}

impl AppState {
    fn new() -> Self {
        Self { client: Mutex::new(None) }
    }
}

// Default Autonomi mainnet bootstrap peers, mirroring the Android app's
// ConnectionManager.DEFAULT_PEERS. User can override per-call.
const DEFAULT_PEERS: &[&str] = &[
    "/ip4/207.148.94.42/udp/10000/quic",
    "/ip4/45.77.50.10/udp/10000/quic",
    "/ip4/66.135.23.83/udp/10000/quic",
    "/ip4/149.248.9.2/udp/10000/quic",
    "/ip4/49.12.119.240/udp/10000/quic",
    "/ip4/5.161.25.133/udp/10000/quic",
    "/ip4/18.228.202.183/udp/10000/quic",
];

#[tauri::command]
async fn connect(peers: Option<Vec<String>>, state: State<'_, AppState>) -> Result<u64, String> {
    let bootstrap = peers
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| DEFAULT_PEERS.iter().map(|s| s.to_string()).collect());
    let client = ant_ffi::Client::connect(bootstrap)
        .await
        .map_err(|e| format!("{e}"))?;
    let count = client.peer_count().await;
    *state.client.lock().await = Some(client);
    Ok(count)
}

#[tauri::command]
async fn peer_count(state: State<'_, AppState>) -> Result<u64, String> {
    match state.client.lock().await.as_ref() {
        Some(c) => Ok(c.peer_count().await),
        None => Err("not connected".to_string()),
    }
}

#[tauri::command]
async fn fetch_public(addr_hex: String, state: State<'_, AppState>) -> Result<Vec<u8>, String> {
    let client = {
        let guard = state.client.lock().await;
        guard.as_ref().cloned().ok_or_else(|| "not connected".to_string())?
    };
    client.data_get_public(addr_hex).await.map_err(|e| format!("{e}"))
}

#[tauri::command]
async fn disconnect(state: State<'_, AppState>) -> Result<(), String> {
    *state.client.lock().await = None;
    Ok(())
}

#[tauri::command]
async fn save_bytes(path: String, bytes: Vec<u8>) -> Result<(), String> {
    tokio::fs::write(&path, bytes).await.map_err(|e| format!("{e}"))
}

// Mirror types — ant-ffi's uniffi-decorated structs don't auto-serialize
// through Tauri's serde IPC, so we copy fields into plain DTOs here.
#[derive(Serialize)]
struct PaymentDto {
    quote_hash: String,
    rewards_address: String,
    amount: String,
}

#[derive(Serialize)]
struct PreparedPublicEtchDto {
    upload_id: String,
    payments: Vec<PaymentDto>,
    total_amount: String,
    data_map_address: String,
}

#[derive(Serialize)]
struct PublicEtchResultDto {
    address: String,
    chunks_stored: u64,
}

#[tauri::command]
async fn prepare_public_etch(data: Vec<u8>, state: State<'_, AppState>) -> Result<PreparedPublicEtchDto, String> {
    let client = {
        let guard = state.client.lock().await;
        guard.as_ref().cloned().ok_or_else(|| "not connected".to_string())?
    };
    let prep = client.prepare_public_upload(data).await.map_err(|e| format!("{e}"))?;
    Ok(PreparedPublicEtchDto {
        upload_id: prep.upload_id,
        payments: prep.payments.into_iter().map(|p| PaymentDto {
            quote_hash: p.quote_hash,
            rewards_address: p.rewards_address,
            amount: p.amount,
        }).collect(),
        total_amount: prep.total_amount,
        data_map_address: prep.data_map_address,
    })
}

#[tauri::command]
async fn finalize_public_etch(upload_id: String, tx_hashes: HashMap<String, String>, state: State<'_, AppState>) -> Result<PublicEtchResultDto, String> {
    let client = {
        let guard = state.client.lock().await;
        guard.as_ref().cloned().ok_or_else(|| "not connected".to_string())?
    };
    let res = client.finalize_public_upload(upload_id, tx_hashes).await.map_err(|e| format!("{e}"))?;
    Ok(PublicEtchResultDto {
        address: res.address,
        chunks_stored: res.chunks_stored,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            connect,
            peer_count,
            fetch_public,
            disconnect,
            save_bytes,
            prepare_public_etch,
            finalize_public_etch
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
