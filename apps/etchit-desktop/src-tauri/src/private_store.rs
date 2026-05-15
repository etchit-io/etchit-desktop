//! Local persistence of private-etch entries.
//!
//! Each entry holds the data-map (the secret that decrypts the chunks)
//! plus a small amount of metadata so the user can find the entry
//! later. Stored at `<app_data_dir>/private_etches.json`.
//!
//! **V1 stores the data-map in plaintext.** The file lives in the OS's
//! per-user app-data directory, which is mode 700 on Linux/macOS and
//! NTFS-protected on Windows — same protections as `history.json`. A
//! later revision will add wallet-derived-key encryption (mirroring
//! the old desktop's `SIGN_MESSAGE_PRIVATE` derivation) so that a
//! leaked file is still useless without the wallet signature; the
//! `wallet_address` field is recorded today so that upgrade can
//! re-encrypt by owner without losing the user's library.

use std::fs;
use std::io::Write;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// One persisted private etch.
///
/// Two encryption-state-of-`data_map` shapes coexist:
///
/// 1. **Cipher form** (new, default): `cipher_data_map` carries the
///    AES-256-GCM-wrapped data-map and `data_map` is absent / empty.
///    `owner_id` identifies the wallet whose at-rest key decrypts it.
/// 2. **Plaintext form** (legacy, back-compat): `data_map` holds the
///    raw hex data-map; `cipher_data_map` is absent. The next time
///    the entry is touched the JS side migrates it to cipher form.
///
/// The Rust side doesn't care which form is on disk — it just
/// round-trips the JSON. Encryption / decryption lives in the JS
/// layer next to the wallet signer that holds the at-rest key.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrivateEntry {
    /// Random identifier — what the user clicks on in the Private tab.
    pub id: String,
    /// User-provided title (or first body line / file basename).
    pub title: String,
    /// Legacy plaintext data-map (hex). Empty on cipher-form entries;
    /// retained so existing pre-encryption libraries keep working.
    #[serde(default)]
    pub data_map: String,
    /// AES-256-GCM-wrapped data-map (hex of `iv || ct || tag`). New
    /// entries always carry this; readers prefer it when present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cipher_data_map: Option<String>,
    /// Wallet identifier whose at-rest key decrypts `cipher_data_map`.
    /// `0x…` address for external mode, `keychain:0x…` for internal.
    /// Stored so we know which key to derive on read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_id: Option<String>,
    /// Original payload size (in bytes) for the size hint in the library.
    pub size_bytes: u64,
    /// `"internal"` or `"external"`. Lets the UI explain which wallet
    /// paid for the entry.
    pub wallet_mode: String,
    /// 0x-prefixed lowercase hex address of the wallet that paid.
    pub wallet_address: String,
    /// Chunks stored count, from the finalize result.
    pub chunks_stored: u64,
    /// Unix milliseconds at upload success.
    pub ts_ms: i64,
    /// `"text"` (raw UTF-8 body) or `"file"` (raw bytes — the UI offers
    /// Save As… instead of rendering inline). Defaults to `"text"`
    /// for entries written before this field existed.
    #[serde(default = "default_kind")]
    pub kind: String,
    /// Basename of the source file when `kind == "file"`, surfaced as
    /// the default suggested filename when the user clicks Save As…
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_filename: Option<String>,
}

fn default_kind() -> String {
    "text".into()
}

#[derive(Debug, Serialize, Deserialize)]
struct PrivateFile {
    v: u32,
    entries: Vec<PrivateEntry>,
}

const FILE_NAME: &str = "private_etches.json";
const FILE_VERSION: u32 = 1;
const MAX_ENTRIES: usize = 1000;

fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("couldn't create {}: {e}", dir.display()))?;
    Ok(dir.join(FILE_NAME))
}

fn read_file(path: &PathBuf) -> Result<PrivateFile, String> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice::<PrivateFile>(&bytes)
            .map_err(|e| format!("private store is corrupt: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(PrivateFile {
            v: FILE_VERSION,
            entries: Vec::new(),
        }),
        Err(e) => Err(format!("couldn't read private store: {e}")),
    }
}

fn write_file_atomic(path: &PathBuf, file: &PrivateFile) -> Result<(), String> {
    let bytes =
        serde_json::to_vec_pretty(file).map_err(|e| format!("serialize failed: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    {
        let mut f =
            fs::File::create(&tmp).map_err(|e| format!("couldn't open {}: {e}", tmp.display()))?;
        f.write_all(&bytes)
            .map_err(|e| format!("couldn't write {}: {e}", tmp.display()))?;
        f.sync_all().map_err(|e| format!("fsync failed: {e}"))?;
    }
    fs::rename(&tmp, path).map_err(|e| format!("rename failed: {e}"))
}

/// Newest first.
#[tauri::command]
pub fn private_load(app: AppHandle) -> Result<Vec<PrivateEntry>, String> {
    let path = store_path(&app)?;
    let mut file = read_file(&path)?;
    file.entries.sort_by(|a, b| b.ts_ms.cmp(&a.ts_ms));
    Ok(file.entries)
}

/// Append a new private entry. Caller generates `id` so a successful
/// upload can be associated with a local row before we hit the disk.
/// Trims to [`MAX_ENTRIES`] (oldest dropped first).
#[tauri::command]
pub fn private_append(
    app: AppHandle,
    entry: PrivateEntry,
) -> Result<Vec<PrivateEntry>, String> {
    if entry.id.is_empty() {
        return Err("entry has no id".into());
    }
    if entry.data_map.is_empty() && entry.cipher_data_map.as_deref().unwrap_or("").is_empty() {
        return Err(
            "entry has neither data_map nor cipher_data_map — refusing to persist an empty row"
                .into(),
        );
    }
    let path = store_path(&app)?;
    let mut file = read_file(&path)?;
    // Treat id as the unique key. Re-uploading should be rare; if it
    // happens we replace the row rather than duplicate.
    if let Some(pos) = file.entries.iter().position(|e| e.id == entry.id) {
        file.entries[pos] = entry;
    } else {
        file.entries.push(entry);
    }
    if file.entries.len() > MAX_ENTRIES {
        file.entries.sort_by(|a, b| b.ts_ms.cmp(&a.ts_ms));
        file.entries.truncate(MAX_ENTRIES);
    }
    write_file_atomic(&path, &file)?;
    file.entries.sort_by(|a, b| b.ts_ms.cmp(&a.ts_ms));
    Ok(file.entries)
}

/// Delete an entry by id. Idempotent.
#[tauri::command]
pub fn private_delete(
    app: AppHandle,
    id: String,
) -> Result<Vec<PrivateEntry>, String> {
    let path = store_path(&app)?;
    let mut file = read_file(&path)?;
    file.entries.retain(|e| e.id != id);
    write_file_atomic(&path, &file)?;
    file.entries.sort_by(|a, b| b.ts_ms.cmp(&a.ts_ms));
    Ok(file.entries)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    fn sample(id: &str, ts: i64) -> PrivateEntry {
        PrivateEntry {
            id: id.into(),
            title: format!("entry {id}"),
            data_map: format!("dm-{id}"),
            cipher_data_map: None,
            owner_id: None,
            size_bytes: 12,
            wallet_mode: "internal".into(),
            wallet_address: "0xabc".into(),
            chunks_stored: 1,
            ts_ms: ts,
            kind: "text".into(),
            original_filename: None,
        }
    }

    #[test]
    fn cipher_only_entry_round_trips() {
        // New-shape entry — data_map empty, cipher_data_map populated.
        let raw = r#"{"v":1,"entries":[{
            "id":"x","title":"t","data_map":"",
            "cipher_data_map":"abcdef","owner_id":"keychain:0x1",
            "size_bytes":1,"wallet_mode":"internal","wallet_address":"0x",
            "chunks_stored":1,"ts_ms":1
        }]}"#;
        let parsed: PrivateFile = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.entries[0].data_map, "");
        assert_eq!(parsed.entries[0].cipher_data_map.as_deref(), Some("abcdef"));
        assert_eq!(parsed.entries[0].owner_id.as_deref(), Some("keychain:0x1"));
    }

    #[test]
    fn missing_kind_defaults_to_text_for_back_compat() {
        // An entry written before the `kind` field existed must still
        // round-trip — the V1 format had no `kind` and we don't want
        // to invalidate users' existing libraries.
        let raw = r#"{"v":1,"entries":[{
            "id":"a","title":"t","data_map":"dm","size_bytes":1,
            "wallet_mode":"internal","wallet_address":"0x","chunks_stored":1,
            "ts_ms":1
        }]}"#;
        let parsed: PrivateFile = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.entries[0].kind, "text");
        assert!(parsed.entries[0].original_filename.is_none());
    }

    #[test]
    fn file_roundtrips_through_serde() {
        let file = PrivateFile {
            v: FILE_VERSION,
            entries: vec![sample("a", 1), sample("b", 2)],
        };
        let bytes = serde_json::to_vec(&file).unwrap();
        let back: PrivateFile = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(back.entries.len(), 2);
        assert_eq!(back.entries[0].id, "a");
        assert_eq!(back.entries[1].data_map, "dm-b");
    }
}
