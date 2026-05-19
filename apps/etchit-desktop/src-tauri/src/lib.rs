//! Tauri backend for etch/it desktop — companion publisher to fetch>it.
//!
//! V0 links `ant-ffi` directly (the same crate Android binds to via
//! UniFFI). The user pastes a hex wallet key into Settings → Advanced;
//! it's stored in the OS keychain and consumed by
//! `Client::connect_with_wallet`. `ant-core` handles approval and
//! payment internally. WalletConnect Modal Web lands with the Wallet
//! tab (V1) and swaps in the external-signer flow.

mod archive;
mod blog;
mod etch;
mod history;
mod peers;
mod private_etch;
mod private_store;
mod secrets;
mod settings;
mod wallet;

/// Decode a PNG and write it to the OS clipboard as an image, in a
/// single backend hop. The QR share modal calls this rather than the
/// JS-side `Image.fromBytes(..)` → `writeImage(img)` chain, because
/// that chain crosses the IPC boundary twice carrying an `Image`
/// resource handle in between, and on webkit2gtk the handle can be
/// reaped before the clipboard write resolves. Doing the decode +
/// write in one Rust frame sidesteps the cross-IPC resource lifecycle.
/// The clipboard plugin takes RGBA bytes, not encoded PNG, so we decode
/// here using the `png` crate.
#[tauri::command]
fn copy_png_to_clipboard(app: tauri::AppHandle, data: Vec<u8>) -> Result<(), String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    let decoder = png::Decoder::new(std::io::Cursor::new(&data));
    let mut reader = decoder.read_info().map_err(|e| format!("png header: {e}"))?;
    let mut buf = vec![0u8; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).map_err(|e| format!("png frame: {e}"))?;
    buf.truncate(info.buffer_size());
    // Canvas.toBlob("image/png") emits RGBA8. Widen anything else
    // rather than silently writing a malformed buffer to the clipboard.
    let rgba = match info.color_type {
        png::ColorType::Rgba => buf,
        png::ColorType::Rgb => {
            let mut out = Vec::with_capacity(buf.len() / 3 * 4);
            for px in buf.chunks_exact(3) {
                out.extend_from_slice(&[px[0], px[1], px[2], 0xff]);
            }
            out
        }
        other => return Err(format!("unsupported png color type: {other:?}")),
    };
    let img = tauri::image::Image::new_owned(rgba, info.width, info.height);
    app.clipboard()
        .write_image(&img)
        .map_err(|e| format!("clipboard write: {e}"))
}

/// Synchronously persist the set of screenshot-toast "dismissed"
/// fingerprints to disk. Stored as a JSON array under the app's local
/// data dir.
///
/// We do this through a Tauri command (i.e. a Rust write) instead of
/// `localStorage.setItem` because the screenshot toast's typical user
/// flow is `click Dismiss → close the app` within ~100ms. WebKit2GTK's
/// localStorage flush is asynchronous, and the write is lost when the
/// window terminates before the flush task fires. Routing through Rust
/// writes synchronously to a JSON file, so the dismissed entry survives
/// even a rapid close.
#[tauri::command]
fn screenshot_dismissed_save(
    app: tauri::AppHandle,
    fingerprints: Vec<String>,
) -> Result<(), String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
    let path = dir.join("screenshot_dismissed.json");
    let body = serde_json::to_vec(&fingerprints)
        .map_err(|e| format!("serialise dismissed list: {e}"))?;
    std::fs::write(&path, body).map_err(|e| format!("write {}: {e}", path.display()))
}

/// Companion to `screenshot_dismissed_save`. Returns the saved list, or
/// an empty vec if the file is missing / unreadable / corrupt — the
/// dismissed-set is a UX cache, not security state, so silent recovery
/// is the right call.
#[tauri::command]
fn screenshot_dismissed_load(app: tauri::AppHandle) -> Vec<String> {
    use tauri::Manager;
    let Ok(dir) = app.path().app_local_data_dir() else {
        return Vec::new();
    };
    let path = dir.join("screenshot_dismissed.json");
    let Ok(body) = std::fs::read(&path) else {
        return Vec::new();
    };
    serde_json::from_slice(&body).unwrap_or_default()
}

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
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .manage(etch::EtchState::default())
        .setup(|app| {
            use tauri::Manager;
            // Stash AppHandle so peers::effective_peers() can read the
            // override file from etch.rs without threading AppHandle
            // through every Tauri command + helper signature.
            peers::register_app(app.handle().clone());
            // Persisted settings — currently just the idle-disconnect
            // policy; loaded once at startup, written through on
            // change. `Manager::manage` is on `AppHandle`, not on
            // `&mut App`, so route through `app.handle()`.
            let handle = app.handle().clone();
            handle.manage(settings::SettingsState::new(&handle));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            archive::estimate_zip_size_command,
            etch::etch_file,
            etch::etch_files,
            etch::etch_text,
            etch::etch_bytes,
            etch::fetch_public_bytes,
            etch::peer_count,
            blog::etch_html,
            secrets::store_secret_key,
            secrets::clear_secret_key,
            secrets::has_secret_key,
            secrets::get_private_passphrase,
            secrets::store_private_passphrase,
            secrets::clear_private_passphrase,
            secrets::has_private_passphrase,
            history::history_load,
            history::history_append,
            history::history_delete,
            history::history_clear,
            wallet::internal_wallet_info,
            wallet::internal_wallet_address,
            wallet::prepare_public_etch,
            wallet::prepare_public_etch_text,
            wallet::prepare_public_etch_file,
            wallet::prepare_public_etch_files,
            wallet::finalize_public_etch,
            private_etch::prepare_private_etch,
            private_etch::prepare_private_etch_file,
            private_etch::prepare_private_etch_files,
            private_etch::finalize_private_etch,
            private_etch::private_etch_internal_text,
            private_etch::private_etch_internal_file,
            private_etch::private_etch_internal_files,
            private_etch::fetch_private_data,
            private_etch::save_bytes_to_path,
            private_etch::file_size,
            private_etch::is_directory,
            private_etch::read_file_bytes,
            private_store::private_load,
            private_store::private_append,
            private_store::private_delete,
            peers::default_peers_cmd,
            peers::peers_override_cmd,
            peers::set_peers_override_cmd,
            peers::reset_peers_override_cmd,
            peers::refresh_peers_from_upstream_cmd,
            settings::idle_policy,
            settings::set_idle_policy,
            settings::idle_disconnect,
            open_in_fetchit,
            copy_png_to_clipboard,
            screenshot_dismissed_save,
            screenshot_dismissed_load,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
