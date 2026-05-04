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

#[derive(Serialize)]
struct PreparedPrivateEtchDto {
    upload_id: String,
    payments: Vec<PaymentDto>,
    total_amount: String,
    data_map: String,
}

#[derive(Serialize)]
struct PrivateEtchResultDto {
    chunks_stored: u64,
}

#[tauri::command]
async fn prepare_private_etch(data: Vec<u8>, state: State<'_, AppState>) -> Result<PreparedPrivateEtchDto, String> {
    let client = {
        let guard = state.client.lock().await;
        guard.as_ref().cloned().ok_or_else(|| "not connected".to_string())?
    };
    let prep = client.prepare_data_upload(data).await.map_err(|e| format!("{e}"))?;
    Ok(PreparedPrivateEtchDto {
        upload_id: prep.upload_id,
        payments: prep.payments.into_iter().map(|p| PaymentDto {
            quote_hash: p.quote_hash,
            rewards_address: p.rewards_address,
            amount: p.amount,
        }).collect(),
        total_amount: prep.total_amount,
        data_map: prep.data_map,
    })
}

#[tauri::command]
async fn finalize_private_etch(upload_id: String, tx_hashes: HashMap<String, String>, state: State<'_, AppState>) -> Result<PrivateEtchResultDto, String> {
    let client = {
        let guard = state.client.lock().await;
        guard.as_ref().cloned().ok_or_else(|| "not connected".to_string())?
    };
    let res = client.finalize_upload(upload_id, tx_hashes).await.map_err(|e| format!("{e}"))?;
    Ok(PrivateEtchResultDto { chunks_stored: res.chunks_stored })
}

#[tauri::command]
async fn fetch_private(data_map_hex: String, state: State<'_, AppState>) -> Result<Vec<u8>, String> {
    let client = {
        let guard = state.client.lock().await;
        guard.as_ref().cloned().ok_or_else(|| "not connected".to_string())?
    };
    client.data_get_private(data_map_hex).await.map_err(|e| format!("{e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Bridge log:: macros into tracing, then init a stderr fmt subscriber.
    // ant-core / ant-node / saorsa-* use both log + tracing; this captures
    // both. Default filter keeps DHT activity visible at warn level — the
    // dht_network_manager module is silenced because it logs per-iteration
    // dial attempts (tens of thousands of lines per second when peers are
    // unreachable, which fills disk). Override with RUST_LOG.
    let _ = tracing_log::LogTracer::init();
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new(
            "info,ant_ffi=debug,ant_core=debug,ant_node=info,saorsa_transport=warn,saorsa_core=warn,saorsa_core::dht_network_manager=error"
        ));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(true)
        .with_writer(std::io::stderr)
        .try_init();

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
            finalize_public_etch,
            prepare_private_etch,
            finalize_private_etch,
            fetch_private
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
