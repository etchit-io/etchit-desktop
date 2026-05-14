//! Tauri backend for etch/it desktop — companion publisher to fetch>it.
//!
//! V0 shells out to the `ant` CLI (`ant file upload --public <path>`) for
//! every upload. Native wallet integration (WalletConnect Modal Web) lands
//! when the Wallet tab is implemented; until then, `ant` manages its own
//! keys + config in `~/.config/autonomi/`.

mod etch;

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

/// Run the Tauri app.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            etch::etch_file,
            etch::etch_text,
            open_in_fetchit,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
