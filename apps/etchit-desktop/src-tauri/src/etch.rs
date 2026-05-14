//! Etch tab commands — shell out to `ant file upload --public <path>` and
//! return the resulting 64-hex address. Two entry points:
//!
//! - [`etch_file`]: caller supplies the absolute path. Uploads as-is, no
//!   transformation. For arbitrary user-picked files (images, video, EPUB,
//!   PDF, anything).
//! - [`etch_text`]: caller supplies title + body. We wrap them in the
//!   etch/it envelope JSON, write to a unique temp file, upload that, then
//!   delete the temp. fetch>it's `EtchitEnvelopeHandler` recognises the
//!   shape on the read side. The envelope contains no literal etch/it
//!   identifier — uploads stay neutral per `docs/upload-neutrality.md`.

use std::process::Stdio;

use tokio::process::Command;

/// Upload a file at `path` via the `ant` CLI and return the 64-hex
/// address. The shell-out is intentional for V0 — see `docs/desktop-roadmap.md`.
#[tauri::command]
pub async fn etch_file(path: String) -> Result<String, String> {
    let output = Command::new("ant")
        .args(["file", "upload", "--public", &path])
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|e| format!("failed to launch `ant`: {e}. Is the ant CLI installed and on $PATH?"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    if !output.status.success() {
        return Err(format!(
            "ant exited with {}:\n{stderr}{stdout}",
            output.status,
        ));
    }

    parse_address(&format!("{stdout}\n{stderr}")).ok_or_else(|| {
        format!("no 64-hex address found in ant output.\nstdout:\n{stdout}\nstderr:\n{stderr}")
    })
}

/// Wrap `title` + `body` in the etch/it envelope JSON and upload via
/// [`etch_file`]. The temp file is removed regardless of upload outcome.
#[tauri::command]
pub async fn etch_text(title: String, body: String) -> Result<String, String> {
    let envelope = build_envelope(&title, &body);
    let temp = tempfile::Builder::new()
        .prefix("etchit-")
        .suffix(".txt")
        .tempfile()
        .map_err(|e| format!("couldn't create temp file: {e}"))?;
    let path = temp.path().to_path_buf();
    tokio::fs::write(&path, envelope.as_bytes())
        .await
        .map_err(|e| format!("temp write failed: {e}"))?;
    etch_file(path.to_string_lossy().into_owned()).await
    // `temp` drops here; the file is unlinked.
}

fn build_envelope(title: &str, body: &str) -> String {
    let t = serde_json::to_string(title.trim()).unwrap_or_else(|_| "\"\"".into());
    let b = serde_json::to_string(body).unwrap_or_else(|_| "\"\"".into());
    format!(r#"{{"v":1,"meta":{{"title":{t},"lang":""}},"content":{b}}}"#)
}

fn parse_address(s: &str) -> Option<String> {
    for line in s.lines() {
        for raw in line.split(|c: char| !c.is_ascii_alphanumeric()) {
            if raw.len() == 64 && raw.chars().all(|c| c.is_ascii_hexdigit()) {
                return Some(raw.to_ascii_lowercase());
            }
        }
    }
    None
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    const REAL: &str = "f4b86ae19e4b1e625ea2af9b15015340443988407f0ae56d28a1050e64ece167";

    #[test]
    fn parse_address_finds_64_hex() {
        let out = format!("connecting\nuploaded to: {REAL}\nok\n");
        assert_eq!(parse_address(&out).as_deref(), Some(REAL));
    }

    #[test]
    fn parse_address_returns_none_when_absent() {
        assert!(parse_address("just some words 12345 done").is_none());
    }

    #[test]
    fn parse_address_lowercases_match() {
        let out = REAL.to_uppercase();
        assert_eq!(parse_address(&out).as_deref(), Some(REAL));
    }

    #[test]
    fn parse_address_skips_non_64_hex_runs() {
        let short = "a".repeat(63);
        let mixed = "abc".repeat(40);
        let out = format!("{short} {mixed} {REAL}");
        assert_eq!(parse_address(&out).as_deref(), Some(REAL));
    }

    #[test]
    fn build_envelope_matches_android_shape() {
        let s = build_envelope("Hello", "world");
        assert_eq!(s, r#"{"v":1,"meta":{"title":"Hello","lang":""},"content":"world"}"#);
    }

    #[test]
    fn build_envelope_escapes_specials() {
        let s = build_envelope("a\"b", "c\\d\ne");
        let parsed: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert_eq!(parsed["meta"]["title"], "a\"b");
        assert_eq!(parsed["content"], "c\\d\ne");
    }

    #[test]
    fn build_envelope_trims_title_only() {
        let s = build_envelope("  trim  ", "  keep  ");
        let parsed: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert_eq!(parsed["meta"]["title"], "trim");
        assert_eq!(parsed["content"], "  keep  ");
    }

    #[test]
    fn build_envelope_carries_no_brand_string() {
        let s = build_envelope("anything", "any body");
        let lower = s.to_lowercase();
        for forbidden in ["etchit", "etch/it", "etch>it", "etchit.io"] {
            assert!(!lower.contains(forbidden), "envelope must not contain {forbidden}");
        }
    }
}
