//! Local-only history of past etches.
//!
//! Lives at `<app_data_dir>/history.json`. No network calls — entries
//! are appended by the upload tabs after they get an address back. The
//! file is atomically replaced on every write (write to `.tmp` and
//! rename) so a crash mid-write can't corrupt the list.
//!
//! Entry identity is the 64-hex address. Re-etching identical content
//! produces the same address; the second append overwrites the first
//! (timestamp + label refresh). This mirrors the user's mental model:
//! "this address is one thing in my history".

use std::fs;
use std::io::Write;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// One row in the history list.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryEntry {
    /// 64-hex Autonomi address.
    pub address: String,
    /// Caller-supplied label. The composer that produced the upload
    /// picks something sensible: post title for blog, file basename
    /// for file uploads, first line for text etches, site name for
    /// website etches.
    pub label: String,
    /// One of `"text"`, `"file"`, `"blog"`, `"site"`.
    pub kind: String,
    /// Unix milliseconds at the moment the upload succeeded.
    pub ts_ms: i64,
    /// Number of chunks stored, when the upload path surfaces it
    /// (`data_put_public`). `None` for `file_upload_public` — the
    /// ant-ffi result doesn't expose it for that path.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chunks_stored: Option<u64>,
}

/// On-disk file shape. Versioned so we can migrate later if the
/// structure changes.
#[derive(Debug, Serialize, Deserialize)]
struct HistoryFile {
    v: u32,
    entries: Vec<HistoryEntry>,
}

/// Hard cap on how many entries we keep. Old ones drop off the bottom
/// once this is exceeded — there's no value in unbounded growth for a
/// solo user's personal log, and bounding the file keeps reads cheap.
const MAX_ENTRIES: usize = 500;

const FILE_VERSION: u32 = 1;
const FILE_NAME: &str = "history.json";

fn history_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("couldn't create {}: {e}", dir.display()))?;
    Ok(dir.join(FILE_NAME))
}

fn read_file(path: &PathBuf) -> Result<HistoryFile, String> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice::<HistoryFile>(&bytes)
            .map_err(|e| format!("history file is corrupt: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(HistoryFile {
            v: FILE_VERSION,
            entries: Vec::new(),
        }),
        Err(e) => Err(format!("couldn't read history: {e}")),
    }
}

fn write_file_atomic(path: &PathBuf, file: &HistoryFile) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(file).map_err(|e| format!("serialize failed: {e}"))?;
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

/// Read every entry. Newest first.
#[tauri::command]
pub fn history_load(app: AppHandle) -> Result<Vec<HistoryEntry>, String> {
    let path = history_path(&app)?;
    let mut file = read_file(&path)?;
    sort_newest_first(&mut file.entries);
    Ok(file.entries)
}

/// Append (or upsert by address) a single entry, trim to cap, persist.
/// Returns the post-write list so the caller can refresh the UI without
/// a second round-trip.
#[tauri::command]
pub fn history_append(app: AppHandle, entry: HistoryEntry) -> Result<Vec<HistoryEntry>, String> {
    if entry.address.is_empty() {
        return Err("entry has no address".into());
    }
    let path = history_path(&app)?;
    let mut file = read_file(&path)?;
    upsert(&mut file.entries, entry);
    trim(&mut file.entries);
    write_file_atomic(&path, &file)?;
    sort_newest_first(&mut file.entries);
    Ok(file.entries)
}

/// Drop one entry by address. Idempotent.
#[tauri::command]
pub fn history_delete(app: AppHandle, address: String) -> Result<Vec<HistoryEntry>, String> {
    let path = history_path(&app)?;
    let mut file = read_file(&path)?;
    file.entries.retain(|e| e.address != address);
    write_file_atomic(&path, &file)?;
    sort_newest_first(&mut file.entries);
    Ok(file.entries)
}

/// Drop every entry. Used by the "Clear history" affordance.
#[tauri::command]
pub fn history_clear(app: AppHandle) -> Result<(), String> {
    let path = history_path(&app)?;
    let empty = HistoryFile {
        v: FILE_VERSION,
        entries: Vec::new(),
    };
    write_file_atomic(&path, &empty)
}

fn upsert(entries: &mut Vec<HistoryEntry>, entry: HistoryEntry) {
    if let Some(pos) = entries.iter().position(|e| e.address == entry.address) {
        entries[pos] = entry;
    } else {
        entries.push(entry);
    }
}

fn trim(entries: &mut Vec<HistoryEntry>) {
    if entries.len() <= MAX_ENTRIES {
        return;
    }
    sort_newest_first(entries);
    entries.truncate(MAX_ENTRIES);
}

fn sort_newest_first(entries: &mut [HistoryEntry]) {
    entries.sort_by(|a, b| b.ts_ms.cmp(&a.ts_ms));
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    fn entry(addr: &str, label: &str, ts: i64) -> HistoryEntry {
        HistoryEntry {
            address: addr.into(),
            label: label.into(),
            kind: "text".into(),
            ts_ms: ts,
            chunks_stored: None,
        }
    }

    #[test]
    fn upsert_adds_new() {
        let mut v = vec![entry("a", "A", 1)];
        upsert(&mut v, entry("b", "B", 2));
        assert_eq!(v.len(), 2);
        assert_eq!(v[1].address, "b");
    }

    #[test]
    fn upsert_replaces_same_address() {
        let mut v = vec![entry("a", "old", 1)];
        upsert(&mut v, entry("a", "new", 2));
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].label, "new");
        assert_eq!(v[0].ts_ms, 2);
    }

    #[test]
    fn sort_newest_first_orders_by_ts_descending() {
        let mut v = vec![entry("a", "A", 1), entry("b", "B", 3), entry("c", "C", 2)];
        sort_newest_first(&mut v);
        assert_eq!(
            v.iter().map(|e| e.address.as_str()).collect::<Vec<_>>(),
            vec!["b", "c", "a"]
        );
    }

    #[test]
    fn trim_keeps_newest_when_over_cap() {
        let mut v: Vec<HistoryEntry> = (0..MAX_ENTRIES as i64 + 5)
            .map(|i| entry(&format!("a{i:03}"), &format!("L{i}"), i))
            .collect();
        trim(&mut v);
        assert_eq!(v.len(), MAX_ENTRIES);
        // After trim, newest (ts = MAX_ENTRIES + 4) must be present and
        // oldest (ts = 0..5) must be gone.
        assert!(v.iter().any(|e| e.ts_ms == MAX_ENTRIES as i64 + 4));
        assert!(v.iter().all(|e| e.ts_ms >= 5));
    }

    #[test]
    fn trim_is_noop_under_cap() {
        let mut v = vec![entry("a", "A", 1), entry("b", "B", 2)];
        trim(&mut v);
        assert_eq!(v.len(), 2);
    }

    #[test]
    fn file_roundtrip_through_serde() {
        let original = HistoryFile {
            v: FILE_VERSION,
            entries: vec![
                entry("aaa", "first", 100),
                HistoryEntry {
                    address: "bbb".into(),
                    label: "with chunks".into(),
                    kind: "blog".into(),
                    ts_ms: 200,
                    chunks_stored: Some(7),
                },
            ],
        };
        let bytes = serde_json::to_vec(&original).unwrap();
        let back: HistoryFile = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(back.v, FILE_VERSION);
        assert_eq!(back.entries.len(), 2);
        assert_eq!(back.entries[1].chunks_stored, Some(7));
    }

    #[test]
    fn chunks_stored_is_omitted_when_none() {
        let e = entry("aaa", "label", 1);
        let s = serde_json::to_string(&e).unwrap();
        assert!(!s.contains("chunks_stored"));
    }
}
