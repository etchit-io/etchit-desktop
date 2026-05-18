//! Bootstrap-peer management for etch/it desktop.
//!
//! Three layers, highest priority wins:
//!   1. User override (persisted as one peer per line at
//!      `<app_data>/peers_override.txt`).
//!   2. Baked-in `DEFAULT_PEERS` — verbatim copy of
//!      `WithAutonomi/ant-node`'s `config/bootstrap_peers.toml`.
//!   3. Upstream refresh — pulls the same file at user request and
//!      stores the result as the override (so it persists across
//!      launches without bumping the binary).
//!
//! Without this the FFI gets `Vec::new()` for bootstrap peers and a
//! fresh install with no peer-cache fails to connect at all — the
//! Windows-fresh-PC symptom that triggered this module.

use serde::Serialize;
use std::fs;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// Populated once by [`register_app`] from the Tauri setup callback so
/// the `Vec::new() → peers::effective_peers()` swap inside
/// `etch::get_or_build_*_client` doesn't have to thread an `AppHandle`
/// through every Tauri command and helper. Same pattern fetchit-desktop
/// uses for `MEDIA_URL_BASE`.
static APP: OnceLock<AppHandle> = OnceLock::new();

pub fn register_app(app: AppHandle) {
    let _ = APP.set(app);
}

fn app() -> Option<&'static AppHandle> {
    APP.get()
}

/// Last synced: 2026-05-18 (matches `ant-node@main`).
pub const DEFAULT_PEERS: &[&str] = &[
    "207.148.94.42:10000",
    "45.77.50.10:10000",
    "66.135.23.83:10000",
    "149.248.9.2:10000",
    "49.12.119.240:10000",
    "5.161.25.133:10000",
    "18.228.202.183:10000",
];

const UPSTREAM_URL: &str =
    "https://raw.githubusercontent.com/WithAutonomi/ant-node/main/config/bootstrap_peers.toml";

const OVERRIDE_FILENAME: &str = "peers_override.txt";

pub fn default_peers() -> Vec<String> {
    DEFAULT_PEERS.iter().map(|s| (*s).to_owned()).collect()
}

fn override_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir unavailable: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("create {} failed: {e}", dir.display()))?;
    Ok(dir.join(OVERRIDE_FILENAME))
}

fn load_override(app: &AppHandle) -> Vec<String> {
    let Ok(path) = override_path(app) else {
        return Vec::new();
    };
    let Ok(s) = fs::read_to_string(&path) else {
        return Vec::new();
    };
    s.lines()
        .map(|l| l.trim().to_owned())
        .filter(|l| !l.is_empty())
        .collect()
}

fn save_override(app: &AppHandle, peers: &[String]) -> Result<(), String> {
    let path = override_path(app)?;
    let body = peers
        .iter()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    fs::write(&path, body).map_err(|e| format!("write {} failed: {e}", path.display()))
}

fn clear_override(app: &AppHandle) -> Result<(), String> {
    let path = override_path(app)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("remove {} failed: {e}", path.display())),
    }
}

/// What the connect path actually dials: override if set, else defaults.
/// Called from `etch::get_or_build_*_client` via the OnceLock-stashed
/// `AppHandle`. Falls back to baked-in defaults if `register_app` hasn't
/// run yet (only possible if a connect somehow races the setup hook,
/// which Tauri's invoke_handler doesn't permit in practice).
pub fn effective_peers() -> Vec<String> {
    let user = app().map(load_override).unwrap_or_default();
    if user.is_empty() {
        default_peers()
    } else {
        user
    }
}

/// Validate one bootstrap-peer string. Accepts an `ip:port` shorthand
/// or a full multiaddr; mirrors `fetchit-net::parse_bootstrap_peer` so
/// the two stay in lockstep on what counts as valid input.
pub fn validate(raw: &str) -> Result<(), String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("empty peer".into());
    }
    if raw.parse::<std::net::SocketAddr>().is_ok() {
        return Ok(());
    }
    if raw.starts_with("/ip4/") || raw.starts_with("/ip6/") || raw.starts_with("/dns") {
        return Ok(());
    }
    Err(format!("invalid bootstrap peer {raw:?} — expected ip:port or /ip4/.../udp/.../quic"))
}

async fn fetch_upstream() -> Result<Vec<String>, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| format!("http client build: {e}"))?;
    let body = client
        .get(UPSTREAM_URL)
        .send()
        .await
        .map_err(|e| format!("GET {UPSTREAM_URL} failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("upstream HTTP error: {e}"))?
        .text()
        .await
        .map_err(|e| format!("read upstream body: {e}"))?;
    parse_peers_toml(&body)
}

/// Tolerant TOML scan — accepts either `peers = […]` at the top level
/// or `[[peer]] addr = "…"` tables, since WithAutonomi has shipped both
/// shapes historically. Falls back to extracting any string-valued
/// leaves that pass [`validate`], so a future minor schema change still
/// lands at least some peers rather than failing the refresh outright.
fn parse_peers_toml(body: &str) -> Result<Vec<String>, String> {
    let value: toml::Value = body
        .parse()
        .map_err(|e| format!("upstream is not valid TOML: {e}"))?;
    let mut found: Vec<String> = Vec::new();
    collect_strings(&value, &mut found);
    let cleaned: Vec<String> = found
        .into_iter()
        .filter(|s| validate(s).is_ok())
        .collect();
    if cleaned.is_empty() {
        return Err("upstream TOML had no recognisable peer entries".into());
    }
    Ok(cleaned)
}

fn collect_strings(value: &toml::Value, out: &mut Vec<String>) {
    match value {
        toml::Value::String(s) => out.push(s.clone()),
        toml::Value::Array(arr) => {
            for v in arr {
                collect_strings(v, out);
            }
        }
        toml::Value::Table(t) => {
            for (_, v) in t {
                collect_strings(v, out);
            }
        }
        _ => {}
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshResult {
    /// The peer list now active (effective_peers after the refresh).
    pub peers: Vec<String>,
    /// True if we wrote a new override (upstream differed from previous
    /// effective); false if upstream matched what we already had.
    pub updated: bool,
}

// ── Tauri commands ────────────────────────────────────────────────────

#[tauri::command]
pub fn default_peers_cmd() -> Vec<String> {
    default_peers()
}

#[tauri::command]
pub fn peers_override_cmd(app: AppHandle) -> Vec<String> {
    load_override(&app)
}

#[tauri::command]
pub fn set_peers_override_cmd(
    app: AppHandle,
    peers: Vec<String>,
) -> Result<Vec<String>, String> {
    let cleaned: Vec<String> = peers
        .into_iter()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .collect();
    for p in &cleaned {
        validate(p)?;
    }
    save_override(&app, &cleaned)?;
    Ok(cleaned)
}

#[tauri::command]
pub fn reset_peers_override_cmd(app: AppHandle) -> Result<(), String> {
    clear_override(&app)
}

#[tauri::command]
pub async fn refresh_peers_from_upstream_cmd(app: AppHandle) -> Result<RefreshResult, String> {
    let upstream = fetch_upstream().await?;
    let current = effective_peers();
    if upstream == current {
        return Ok(RefreshResult { peers: current, updated: false });
    }
    // Always overwrite — the "Windows seems to strip it" mitigation is a
    // fresh write on every refresh, no diffing skipped, no soft-merge.
    save_override(&app, &upstream)?;
    Ok(RefreshResult { peers: upstream, updated: true })
}
