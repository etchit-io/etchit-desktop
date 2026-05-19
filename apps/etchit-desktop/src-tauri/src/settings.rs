//! Persisted user settings (`<app_data>/settings.json`). Loaded once
//! at startup; written through whenever the user changes a value
//! from the Settings tab. JSON because it's human-inspectable and the
//! file is tiny — no schema migration tooling needed.
//!
//! The only value persisted today is the idle-disconnect policy.
//! Bootstrap-peer override lives in `peers_override.txt` (one peer
//! per line, simpler shape).

use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex as StdMutex;
use tauri::{AppHandle, Manager};

/// `timeout_minutes == 0` means "never auto-disconnect". Idle = no
/// fetch/etch activity for this many minutes. The timer is driven by
/// the JS side; this is just the persisted policy.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdlePolicy {
    pub timeout_minutes: u32,
}

impl Default for IdlePolicy {
    fn default() -> Self {
        Self { timeout_minutes: 30 }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub idle: IdlePolicy,
}

impl Settings {
    pub fn load(path: &Path) -> Self {
        let Ok(text) = fs::read_to_string(path) else {
            return Self::default();
        };
        serde_json::from_str(&text).unwrap_or_default()
    }

    pub fn save(&self, path: &Path) -> io::Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let text = serde_json::to_string_pretty(self)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        fs::write(path, text)
    }
}

pub struct SettingsState {
    settings: StdMutex<Settings>,
    path: PathBuf,
}

impl SettingsState {
    pub fn new(app: &AppHandle) -> Self {
        let path = app
            .path()
            .app_data_dir()
            .map(|d| d.join("settings.json"))
            .unwrap_or_else(|_| PathBuf::from("settings.json"));
        let settings = Settings::load(&path);
        Self {
            settings: StdMutex::new(settings),
            path,
        }
    }

    pub fn idle_policy(&self) -> IdlePolicy {
        self.settings.lock().map(|s| s.idle).unwrap_or_default()
    }

    pub fn set_idle_policy(&self, policy: IdlePolicy) {
        if let Ok(mut s) = self.settings.lock() {
            s.idle = policy;
            let _ = s.save(&self.path);
        }
    }
}

#[tauri::command]
pub fn idle_policy(state: tauri::State<'_, SettingsState>) -> IdlePolicy {
    state.idle_policy()
}

#[tauri::command]
pub fn set_idle_policy(state: tauri::State<'_, SettingsState>, policy: IdlePolicy) {
    state.set_idle_policy(policy);
}

/// Drop the cached FFI clients so the next etch reconnects fresh.
/// Called from the JS-side idle tracker when the user has been
/// inactive past the configured timeout; the actual disconnect is
/// just clearing the two `EtchState` slots — the underlying
/// `ant-core` `Client` shuts down on drop.
#[tauri::command]
pub async fn idle_disconnect(state: tauri::State<'_, crate::etch::EtchState>) -> Result<(), String> {
    state.drop_clients().await;
    Ok(())
}
