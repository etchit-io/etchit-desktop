//! EIP-191 `personal_sign` over the keychain wallet key.
//!
//! Used by the private-etch at-rest encryption path: the JS side
//! hands the message bytes here, this module signs in Rust using
//! the key stored in the OS keychain (never crosses the IPC
//! boundary), and the 65-byte signature comes back hex-encoded.
//!
//! Implements EIP-191's `personal_sign`:
//!   1. Prefix with `"\x19Ethereum Signed Message:\n" + len(message)`.
//!   2. keccak256 the prefixed bytes.
//!   3. ECDSA-secp256k1 sign with RFC 6979 deterministic-k (so the
//!      same wallet on a different device produces the same
//!      signature, and the derived key matches).
//!   4. Return `r || s || v` with v in `{27, 28}` per legacy
//!      EIP-191.

use k256::ecdsa::{signature::hazmat::PrehashSigner, RecoveryId, Signature, SigningKey};
use sha3::{Digest, Keccak256};

use crate::secrets;

const NO_KEY_HINT: &str =
    "no wallet key stored — sign needs a key in Settings → Advanced.";

/// Sign `message` with the wallet stored in the OS keychain. Returns
/// the 65-byte signature (`r || s || v`) as a `0x`-prefixed
/// lowercase hex string — same shape EIP-1193 providers return.
#[tauri::command]
pub fn personal_sign_with_keychain(message: Vec<u8>) -> Result<String, String> {
    let key_hex = secrets::get_stored_key().ok_or_else(|| NO_KEY_HINT.to_string())?;
    let sig = sign_personal(&message, &key_hex)?;
    Ok(format!("0x{}", hex::encode(sig)))
}

fn sign_personal(message: &[u8], key_hex: &str) -> Result<[u8; 65], String> {
    let key_body = key_hex.strip_prefix("0x").unwrap_or(key_hex);
    let key_bytes =
        hex::decode(key_body).map_err(|e| format!("invalid private-key hex: {e}"))?;
    let sk = SigningKey::from_slice(&key_bytes)
        .map_err(|e| format!("invalid private key: {e}"))?;

    let digest = eip191_digest(message);
    let (signature, recid): (Signature, RecoveryId) = sk
        .sign_prehash(&digest)
        .map_err(|e| format!("sign failed: {e}"))?;
    let r = signature.r().to_bytes();
    let s = signature.s().to_bytes();

    let mut out = [0u8; 65];
    out[..32].copy_from_slice(&r);
    out[32..64].copy_from_slice(&s);
    out[64] = u8::from(recid) + 27;
    Ok(out)
}

fn eip191_digest(message: &[u8]) -> [u8; 32] {
    let mut hasher = Keccak256::new();
    let prefix = format!("\x19Ethereum Signed Message:\n{}", message.len());
    hasher.update(prefix.as_bytes());
    hasher.update(message);
    hasher.finalize().into()
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    // Cross-vector against ethers.js — locks the EIP-191 envelope
    // and RFC 6979 nonce so signatures match what JS-side wallets
    // produce. Pinned at the JS side too if anyone needs to update.
    const TEST_KEY: &str =
        "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";
    const TEST_MSG: &[u8] = b"hello";
    const EXPECTED_SIG: &str = concat!(
        "0xa5d58782075bdf09490159d634d1aae66a8f6777c7247d2f233e9511cfd7c64c",
        "34f288cdbcea5370e4863fdbe9f4d86654c2ba1d86589e9ebb64494c64900859",
        "1b",
    );

    #[test]
    fn matches_ethers_vector() {
        let sig = sign_personal(TEST_MSG, TEST_KEY).unwrap();
        assert_eq!(format!("0x{}", hex::encode(sig)), EXPECTED_SIG);
    }

    #[test]
    fn is_deterministic_per_rfc6979() {
        // Same (key, message) → same signature on every device.
        let a = sign_personal(TEST_MSG, TEST_KEY).unwrap();
        let b = sign_personal(TEST_MSG, TEST_KEY).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn different_messages_yield_different_signatures() {
        let a = sign_personal(b"alpha", TEST_KEY).unwrap();
        let b = sign_personal(b"beta", TEST_KEY).unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn rejects_garbage_key() {
        assert!(sign_personal(TEST_MSG, "0xnope").is_err());
        assert!(sign_personal(TEST_MSG, "1234").is_err());
    }
}
