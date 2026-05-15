//! Tauri backend for etch/it desktop — companion publisher to fetch>it.
//!
//! V0 links `ant-ffi` directly (the same crate Android binds to via
//! UniFFI). The user pastes a hex wallet key into Settings → Advanced;
//! it's stored in the OS keychain and consumed by
//! `Client::connect_with_wallet`. `ant-core` handles approval and
//! payment internally. WalletConnect Modal Web lands with the Wallet
//! tab (V1) and swaps in the external-signer flow.

mod blog;
mod etch;
mod history;
mod secrets;
mod wallet;

/// Hand a freshly-etched `autonomi://<addr>` URL to the OS scheme handler
/// (fetch>it desktop if installed). We shell out to the platform opener
/// rather than navigating the WebView, since Tauri's WebView would just
/// fail to load an unknown scheme.
#[tauri::command]
fn open_in_fetchit(address: String) -> Result<(), String> {
    let url = format!("autonomi://{address}");
    #[cfg(target_os = "linux")]
    let (cmd, args) = ("xdg-open", vec![url]);
    #[cfg(target_os = "macos")]
    let (cmd, args) = ("open", vec![url]);
    #[cfg(target_os = "windows")]
    let (cmd, args) = ("cmd", vec!["/C".into(), "start".into(), String::new(), url]);
    std::process::Command::new(cmd)
        .args(&args)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("couldn't launch `{cmd}`: {e}. Is fetch>it desktop installed?"))
}

/// `ant-core`'s `data_dir()` calls `home_dir().unwrap()` and panics when
/// HOME is unset (Android does this on launch; sandboxed/container Linux
/// can hit it too). Set a sensible fallback before any `ant-ffi` call so
/// the platform-derived data dir resolves to a writable path. No-op when
/// the env var is already populated, which is the normal desktop case.
fn ensure_home_env() {
    if std::env::var_os("HOME").is_none() {
        std::env::set_var("HOME", std::env::temp_dir());
    }
}

/// Run the Tauri app.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    ensure_home_env();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(etch::EtchState::default())
        .invoke_handler(tauri::generate_handler![
            etch::etch_file,
            etch::etch_text,
            blog::etch_html,
            secrets::store_secret_key,
            secrets::clear_secret_key,
            secrets::has_secret_key,
            history::history_load,
            history::history_append,
            history::history_delete,
            history::history_clear,
            wallet::internal_wallet_info,
            wallet::prepare_public_etch,
            wallet::prepare_public_etch_text,
            wallet::prepare_public_etch_file,
            wallet::finalize_public_etch,
            open_in_fetchit,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
