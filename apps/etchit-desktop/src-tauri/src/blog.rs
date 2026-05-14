//! Blog upload — thin passthrough.
//!
//! The blog composer in `src/blog/` (TypeScript) owns template selection,
//! slot extraction, image inlining, and final HTML emission. Once the
//! frontend has the bytes it wants to publish, this command uploads them
//! via the existing `ant-ffi` Client, reusing [`etch::EtchState`] so the
//! cached connection is shared with the Etch tab.
//!
//! Neutrality is enforced on the frontend (each template's serializer
//! ships with vitest assertions). The Rust passthrough does not modify
//! the bytes — what arrives here is what lands on the network.

use tauri::State;

use crate::etch::{self, EtchState};

const HTML_PREFIX: &str = "<!DOCTYPE html>";

/// Upload a pre-rendered HTML page as public data. Returns the 64-hex
/// address. Validates only that the input starts with `<!DOCTYPE html>`
/// — anything else is a frontend bug, and rejecting early gives a clearer
/// error than letting fetch>it's HTML sniffer pick the wrong handler.
#[tauri::command]
pub async fn etch_html(state: State<'_, EtchState>, html: String) -> Result<String, String> {
    if !html.trim_start().starts_with(HTML_PREFIX) {
        return Err("not an HTML document — composer must emit a `<!DOCTYPE html>` page".into());
    }
    let client = etch::get_or_build_client(&state).await?;
    let result = client
        .data_put_public(html.into_bytes(), etch::PAYMENT_MODE.into())
        .await
        .map_err(|e| format!("upload failed: {e}"))?;
    Ok(result.address)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn etch_html_rejects_non_html_input() {
        // No State<EtchState> in unit tests — exercise the validation
        // arm directly through a small helper that mirrors the guard.
        fn guard(html: &str) -> Result<(), String> {
            if !html.trim_start().starts_with(HTML_PREFIX) {
                return Err("not an HTML document".into());
            }
            Ok(())
        }
        assert!(guard("plain text").is_err());
        assert!(guard("{\"v\":1}").is_err());
        assert!(guard("<!DOCTYPE html>\n<html>...</html>").is_ok());
        assert!(guard("  \n<!DOCTYPE html><html>x</html>").is_ok());
    }
}
