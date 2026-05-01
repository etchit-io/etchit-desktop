use std::sync::Arc;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![connect, peer_count, fetch_public, disconnect])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
