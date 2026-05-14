//! Secret storage — wallet keys in the OS keychain.
//!
//! Uses the `keyring` crate, which delegates to macOS Keychain,
//! Windows Credential Manager, or Linux Secret Service over DBus.
//! Nothing ever lives on disk in plaintext. The user pastes their
//! wallet key once in Settings → Advanced; every subsequent etch
//! reads it from the keychain and hands it to `ant-ffi`, which
//! zeroises the string after building the wallet.

use keyring::Entry;

const SERVICE: &str = "io.etchit.desktop";
const ACCOUNT: &str = "ant-wallet-key";

/// Read the stored wallet key, if any. Returns `None` for "no key
/// stored" or any backend failure — the upload path treats both the
/// same way (it tells the user to set a key in Advanced).
pub fn get_stored_key() -> Option<String> {
    let entry = Entry::new(SERVICE, ACCOUNT).ok()?;
    match entry.get_password() {
        Ok(k) => Some(k),
        Err(keyring::Error::NoEntry) => None,
        Err(e) => {
            eprintln!("[etchit] keychain read failed: {e}");
            None
        }
    }
}

/// Parse a wallet private key. Accepts 64-hex with optional `0x`/`0X`
/// prefix and surrounding whitespace; returns the lowercase normalised
/// form. Pure — testable without a keychain.
pub(crate) fn normalize_key(input: &str) -> Option<String> {
    let trimmed = input.trim();
    let body = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
        .unwrap_or(trimmed);
    if body.len() != 64 {
        return None;
    }
    if !body.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    Some(body.to_ascii_lowercase())
}

/// Validate and store a wallet key in the OS keychain. A malformed
/// key is rejected before it touches the keychain.
#[tauri::command]
pub fn store_secret_key(key: String) -> Result<(), String> {
    let normalised = normalize_key(&key)
        .ok_or_else(|| "not a 64-hex private key (with or without 0x prefix)".to_string())?;
    let entry = Entry::new(SERVICE, ACCOUNT).map_err(|e| format!("keychain unavailable: {e}"))?;
    entry
        .set_password(&normalised)
        .map_err(|e| format!("keychain write failed: {e}"))
}

/// Remove the stored wallet key. No-op if none was stored.
#[tauri::command]
pub fn clear_secret_key() -> Result<(), String> {
    let entry = Entry::new(SERVICE, ACCOUNT).map_err(|e| format!("keychain unavailable: {e}"))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("keychain delete failed: {e}")),
    }
}

/// Whether a wallet key is currently stored. Returns presence only —
/// the key itself is never sent back to the UI.
#[tauri::command]
pub fn has_secret_key() -> bool {
    get_stored_key().is_some()
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    const REAL: &str = "f4b86ae19e4b1e625ea2af9b15015340443988407f0ae56d28a1050e64ece167";

    #[test]
    fn accepts_64_hex_lowercase() {
        assert_eq!(normalize_key(REAL).as_deref(), Some(REAL));
    }

    #[test]
    fn accepts_uppercase_and_lowercases_it() {
        assert_eq!(
            normalize_key(&REAL.to_ascii_uppercase()).as_deref(),
            Some(REAL)
        );
    }

    #[test]
    fn accepts_0x_prefix() {
        let with = format!("0x{REAL}");
        assert_eq!(normalize_key(&with).as_deref(), Some(REAL));
    }

    #[test]
    fn accepts_capital_0x_prefix() {
        let with = format!("0X{REAL}");
        assert_eq!(normalize_key(&with).as_deref(), Some(REAL));
    }

    #[test]
    fn trims_surrounding_whitespace() {
        let padded = format!("  {REAL}  \n");
        assert_eq!(normalize_key(&padded).as_deref(), Some(REAL));
    }

    #[test]
    fn rejects_short_input() {
        assert!(normalize_key(&REAL[..63]).is_none());
    }

    #[test]
    fn rejects_long_input() {
        assert!(normalize_key(&format!("{REAL}a")).is_none());
    }

    #[test]
    fn rejects_non_hex_characters() {
        let bad = "z".repeat(64);
        assert!(normalize_key(&bad).is_none());
    }

    #[test]
    fn rejects_empty_input() {
        assert!(normalize_key("").is_none());
    }
}
