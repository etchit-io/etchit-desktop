//! Bundle multiple file/dir paths into a single in-memory ZIP.
//!
//! Compression is **off** (`CompressionMethod::Stored`), on purpose:
//! each inner file's bytes live verbatim inside the archive. Anyone
//! who downloads the ZIP can extract the originals byte-for-byte. The
//! tradeoff is no size win — that's fine; the goal here is "one
//! address, one wallet payment" for related files, not space saving.
//!
//! Directories are walked recursively. Entries are keyed by their
//! path **relative to the input's parent**, so dropping a folder
//! `~/notes/` produces entries like `notes/foo.txt`, `notes/sub/bar.md`
//! — fetch>it's archive index renders them under a `notes/` heading.

use std::fs;
use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};

use zip::write::{FileOptions, ZipWriter};
use zip::CompressionMethod;

/// Predict the byte size of the ZIP that [`bundle_to_zip`] would
/// produce for the given paths, **without actually building it**.
///
/// `Stored + large_file(true)` has fixed overhead per file: 116 bytes
/// for the headers (LFH 30 + LFH-ZIP64-extra 20 + CDFH 46 +
/// CDFH-ZIP64-extra 20) plus the filename written twice. The trailer
/// is a single 22-byte EOCD record (the ZIP64 EOCD locator + record
/// only kick in when the archive itself crosses 4 GB; for that case
/// we under-estimate by ~76 bytes, which is a rounding error in any
/// UI summary). The constants are pinned by `calibrate_overhead` —
/// the integration tests below assert estimate == actual.
/// Tauri-exposed wrapper: takes string paths from the frontend and
/// hands back the estimated ZIP size. Errors are returned as
/// human-readable strings; the caller treats failure as "unknown
/// size" and shows the sum-of-files fallback instead.
#[tauri::command]
pub fn estimate_zip_size_command(paths: Vec<String>) -> Result<u64, String> {
    let path_bufs: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    estimate_zip_size(&path_bufs)
}

pub fn estimate_zip_size(paths: &[PathBuf]) -> Result<u64, String> {
    if paths.is_empty() {
        return Err("no files to estimate".into());
    }
    let mut total: u64 = END_OVERHEAD;
    for path in paths {
        let base = path.parent().unwrap_or(Path::new(""));
        accumulate(path, base, &mut total)?;
    }
    Ok(total)
}

const PER_ENTRY_FIXED: u64 = 116;
const END_OVERHEAD: u64 = 22;

fn accumulate(path: &Path, base: &Path, total: &mut u64) -> Result<(), String> {
    let meta = fs::metadata(path).map_err(|e| format!("stat {}: {e}", path.display()))?;
    let rel = path
        .strip_prefix(base)
        .map_err(|_| format!("{} is not under its declared base", path.display()))?;
    let name = rel
        .to_str()
        .ok_or_else(|| format!("non-UTF-8 path: {}", path.display()))?
        .replace('\\', "/");
    if meta.is_dir() {
        for entry in fs::read_dir(path).map_err(|e| format!("readdir {}: {e}", path.display()))? {
            let entry = entry.map_err(|e| format!("readdir entry: {e}"))?;
            accumulate(&entry.path(), base, total)?;
        }
    } else {
        *total += meta.len() + PER_ENTRY_FIXED + 2 * name.len() as u64;
    }
    Ok(())
}

/// Bundle the given paths into a ZIP archive. The archive is returned
/// in memory as a `Vec<u8>` ready to hand to ant-ffi.
///
/// Empty input is an error — caller should never reach here with an
/// empty list (the UI keeps the Etch button disabled). Same for any
/// path that doesn't exist or can't be read.
pub fn bundle_to_zip(paths: &[PathBuf]) -> Result<Vec<u8>, String> {
    if paths.is_empty() {
        return Err("no files to bundle".into());
    }
    let mut buf = Cursor::new(Vec::new());
    {
        let mut zw = ZipWriter::new(&mut buf);
        let opts: FileOptions<()> = FileOptions::default()
            .compression_method(CompressionMethod::Stored)
            .large_file(true);
        for path in paths {
            let base = path.parent().unwrap_or(Path::new(""));
            add_path(&mut zw, path, base, &opts)?;
        }
        zw.finish()
            .map_err(|e| format!("zip finalize failed: {e}"))?;
    }
    Ok(buf.into_inner())
}

fn add_path<W: Write + std::io::Seek>(
    zw: &mut ZipWriter<W>,
    path: &Path,
    base: &Path,
    opts: &FileOptions<()>,
) -> Result<(), String> {
    let meta = fs::metadata(path).map_err(|e| format!("stat {}: {e}", path.display()))?;
    let rel = path
        .strip_prefix(base)
        .map_err(|_| format!("{} is not under its declared base", path.display()))?;
    let name = rel
        .to_str()
        .ok_or_else(|| format!("non-UTF-8 path: {}", path.display()))?
        // ZIP entries use forward slashes regardless of host OS — the
        // spec mandates `/`, and zip parsers (including fetch>it's) read
        // it that way. Windows paths come in with `\` from the Rust
        // side; rewrite to `/` so the index reads naturally.
        .replace('\\', "/");

    if meta.is_dir() {
        for entry in fs::read_dir(path).map_err(|e| format!("readdir {}: {e}", path.display()))? {
            let entry = entry.map_err(|e| format!("readdir entry: {e}"))?;
            add_path(zw, &entry.path(), base, opts)?;
        }
    } else {
        zw.start_file(&name, *opts)
            .map_err(|e| format!("zip start_file {name}: {e}"))?;
        let bytes = fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
        zw.write_all(&bytes)
            .map_err(|e| format!("zip write {name}: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use std::io::Read;
    use zip::ZipArchive;

    fn tempfile(name: &str, contents: &[u8]) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "etchit-archive-test-{}-{name}",
            std::process::id()
        ));
        fs::write(&path, contents).unwrap();
        path
    }

    fn cleanup(paths: &[PathBuf]) {
        for p in paths {
            let _ = fs::remove_file(p);
            let _ = fs::remove_dir_all(p);
        }
    }

    #[test]
    fn refuses_empty_input() {
        assert!(bundle_to_zip(&[]).is_err());
    }

    #[test]
    fn bundles_two_files_with_basename_entries() {
        let a = tempfile("a.txt", b"hello");
        let b = tempfile("b.txt", b"world");
        let zip = bundle_to_zip(&[a.clone(), b.clone()]).unwrap();
        cleanup(&[a, b]);

        let mut archive = ZipArchive::new(Cursor::new(zip)).unwrap();
        assert_eq!(archive.len(), 2);
        let names: Vec<String> = (0..archive.len())
            .map(|i| archive.by_index(i).unwrap().name().to_string())
            .collect();
        assert!(names.iter().any(|n| n.ends_with("a.txt")));
        assert!(names.iter().any(|n| n.ends_with("b.txt")));
    }

    #[test]
    fn inner_bytes_are_identical_to_originals() {
        let a = tempfile("verbatim.bin", &[0u8, 1, 2, 3, 255, 254, 253]);
        let zip = bundle_to_zip(&[a.clone()]).unwrap();
        cleanup(&[a]);

        let mut archive = ZipArchive::new(Cursor::new(zip)).unwrap();
        let mut entry = archive.by_index(0).unwrap();
        let mut got = Vec::new();
        entry.read_to_end(&mut got).unwrap();
        assert_eq!(got, vec![0u8, 1, 2, 3, 255, 254, 253]);
    }

    #[test]
    fn uses_stored_not_deflate() {
        // Byte-identity contract: the ZIP entry must use Stored, not
        // Deflate. Otherwise a reader without the right decompressor
        // would see compressed bytes instead of the original.
        let a = tempfile("c.txt", b"abcdef");
        let zip = bundle_to_zip(&[a.clone()]).unwrap();
        cleanup(&[a]);

        let mut archive = ZipArchive::new(Cursor::new(zip)).unwrap();
        let entry = archive.by_index(0).unwrap();
        assert_eq!(entry.compression(), CompressionMethod::Stored);
    }

    #[test]
    #[ignore = "calibration probe"]
    fn calibrate_overhead() {
        for entries in 1..=4 {
            for name_len in [5usize, 10, 20] {
                let mut buf = Cursor::new(Vec::new());
                {
                    let mut zw = ZipWriter::new(&mut buf);
                    let opts: FileOptions<()> = FileOptions::default()
                        .compression_method(CompressionMethod::Stored)
                        .large_file(true);
                    for i in 0..entries {
                        let name = format!("{}{i}", "a".repeat(name_len - 1));
                        zw.start_file(&name, opts).unwrap();
                        zw.write_all(b"X").unwrap();
                    }
                    zw.finish().unwrap();
                }
                let size = buf.into_inner().len();
                let data_total = entries;
                println!(
                    "entries={entries} name_len={name_len} total={size} per-entry-overhead={:.1}",
                    (size as f64 - data_total as f64) / entries as f64
                );
            }
        }
    }

    #[test]
    fn estimate_matches_actual_zip_size_for_simple_files() {
        let a = tempfile("est-a.txt", b"hello, world");
        let b = tempfile("est-b.bin", &[0u8; 1024]);
        let paths = vec![a.clone(), b.clone()];
        let estimated = estimate_zip_size(&paths).unwrap();
        let actual = bundle_to_zip(&paths).unwrap().len() as u64;
        cleanup(&[a, b]);
        assert_eq!(
            estimated, actual,
            "estimate {estimated} must match actual zip size {actual}"
        );
    }

    #[test]
    fn estimate_matches_actual_zip_size_for_a_folder() {
        let dir = std::env::temp_dir().join(format!(
            "etchit-archive-test-estimate-{}-folder",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("a.txt"), b"alpha").unwrap();
        let sub = dir.join("sub");
        fs::create_dir_all(&sub).unwrap();
        fs::write(sub.join("b.txt"), &[7u8; 200]).unwrap();
        fs::write(sub.join("c.txt"), &[]).unwrap();
        let estimated = estimate_zip_size(&[dir.clone()]).unwrap();
        let actual = bundle_to_zip(&[dir.clone()]).unwrap().len() as u64;
        cleanup(&[dir]);
        assert_eq!(
            estimated, actual,
            "estimate {estimated} must match actual zip size {actual}"
        );
    }

    #[test]
    fn directory_keeps_its_name_as_top_level_prefix() {
        let dir = std::env::temp_dir().join(format!(
            "etchit-archive-test-dir-{}-folder",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("inner.txt"), b"x").unwrap();
        let nested = dir.join("sub");
        fs::create_dir_all(&nested).unwrap();
        fs::write(nested.join("deeper.txt"), b"y").unwrap();

        let zip = bundle_to_zip(&[dir.clone()]).unwrap();
        let folder_name = dir.file_name().unwrap().to_string_lossy().to_string();
        cleanup(&[dir]);

        let mut archive = ZipArchive::new(Cursor::new(zip)).unwrap();
        let names: Vec<String> = (0..archive.len())
            .map(|i| archive.by_index(i).unwrap().name().to_string())
            .collect();
        // Both entries live under the folder's own name; sub-folders
        // are preserved with `/` separators.
        assert!(names.iter().any(|n| n == &format!("{folder_name}/inner.txt")));
        assert!(names.iter().any(|n| n == &format!("{folder_name}/sub/deeper.txt")));
    }
}
