// Password-encrypted backup of the private-etch library.
//
// Wire format — byte-identical to mobile's `BackupCrypto.kt`:
//
//   17 bytes  magic   "ETCHIT_BACKUP_v1\n"
//   16 bytes  salt    (random per backup)
//   12 bytes  iv      (random per backup)
//   N  bytes  ciphertext + 16-byte GCM tag
//
// Key derivation: PBKDF2-HMAC-SHA256 with 600k iterations → AES-256
// key. The password is whatever the user typed; for the diceware
// path it's six BIP-39 words joined by `-`.
//
// The plaintext under the AEAD is a UTF-8 JSON dump of every private
// entry as-is (cipher_data_map fields included). Restoring on a
// fresh device needs both the password (to unwrap this file) AND the
// same wallet (to unwrap each entry's cipher_data_map) — two factors,
// neither alone is enough.

import {
  BACKUP_IV_LEN,
  BACKUP_MAGIC,
  BACKUP_PBKDF2_ITERATIONS,
  BACKUP_SALT_LEN,
} from "./spec";

async function deriveBackupKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const pwKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password) as BufferSource,
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: BACKUP_PBKDF2_ITERATIONS, hash: "SHA-256" },
    pwKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Encrypt `plaintext` under `password`. Returns the full file bytes
 *  (magic + salt + iv + ciphertext+tag). */
export async function backupEncrypt(
  plaintext: Uint8Array,
  password: string,
): Promise<Uint8Array> {
  const magic = new TextEncoder().encode(BACKUP_MAGIC);
  const salt = crypto.getRandomValues(new Uint8Array(BACKUP_SALT_LEN));
  const iv = crypto.getRandomValues(new Uint8Array(BACKUP_IV_LEN));
  const key = await deriveBackupKey(password, salt);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      plaintext as BufferSource,
    ),
  );
  const out = new Uint8Array(magic.length + salt.length + iv.length + ct.length);
  out.set(magic, 0);
  out.set(salt, magic.length);
  out.set(iv, magic.length + salt.length);
  out.set(ct, magic.length + salt.length + iv.length);
  return out;
}

/** Decrypt a backup file. Returns `null` on bad magic, wrong
 *  password, or tampered bytes — caller surfaces the right error. */
export async function backupDecrypt(
  data: Uint8Array,
  password: string,
): Promise<Uint8Array | null> {
  const magic = new TextEncoder().encode(BACKUP_MAGIC);
  if (data.length < magic.length + BACKUP_SALT_LEN + BACKUP_IV_LEN + 1) return null;
  for (let i = 0; i < magic.length; i++) {
    if (data[i] !== magic[i]) return null;
  }
  let off = magic.length;
  const salt = data.slice(off, off + BACKUP_SALT_LEN);
  off += BACKUP_SALT_LEN;
  const iv = data.slice(off, off + BACKUP_IV_LEN);
  off += BACKUP_IV_LEN;
  const ct = data.slice(off);
  try {
    const key = await deriveBackupKey(password, salt);
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      ct as BufferSource,
    );
    return new Uint8Array(pt);
  } catch {
    return null;
  }
}
