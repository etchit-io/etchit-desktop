// Password-encrypted blob format.
//
// Used by every encrypted artifact in the private-etch system:
//   - Per-entry encrypted-data-map blobs (uploaded to Autonomi as
//     public bytes; address recorded in the local store)
//   - Library backup blobs (file export OR network upload)
//
// Self-contained: every blob carries its own random salt + IV so a
// reader needs only `(blob bytes, password)` to recover the
// plaintext. PBKDF2-HMAC-SHA256 with 600k iterations is slow on
// purpose (resists offline password brute force); a session cache
// (`passwordSession.ts`) memoizes the derived key per salt so the
// 250ms PBKDF2 hit happens once per unique blob and not per call.
//
// Wire layout:
//
//   17 bytes  magic   "ETCHIT_PWENC_v1\n"
//   16 bytes  salt    (per-blob, CSPRNG random)
//   12 bytes  iv      (per-blob, CSPRNG random)
//    N bytes  ct+tag  (AES-256-GCM ciphertext with 16-byte tag appended)

import { deriveKeyForSalt } from "./passwordSession";

const MAGIC = new TextEncoder().encode("ETCHIT_PWENC_v1\n");
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;

export const PWENC_BLOB_MIN_LEN = MAGIC.length + SALT_LEN + IV_LEN + TAG_LEN;

/** Encrypt `plaintext` under `password`. Returns the full blob:
 *  magic + salt + iv + ct + tag. Caller-side, no IPC. */
export async function encryptBlob(
  plaintext: Uint8Array,
  password: string,
): Promise<Uint8Array> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const key = await deriveKeyForSalt(password, salt);
  const aesKey = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource, tagLength: 128 },
      aesKey,
      plaintext as BufferSource,
    ),
  );
  const out = new Uint8Array(MAGIC.length + SALT_LEN + IV_LEN + ct.length);
  out.set(MAGIC, 0);
  out.set(salt, MAGIC.length);
  out.set(iv, MAGIC.length + SALT_LEN);
  out.set(ct, MAGIC.length + SALT_LEN + IV_LEN);
  return out;
}

/** Decrypt a blob produced by [`encryptBlob`]. Returns `null` on
 *  malformed magic, wrong password, or tampered bytes — silent so
 *  the caller renders a single "wrong password / corrupt backup"
 *  error rather than leaking which part failed. */
export async function decryptBlob(
  blob: Uint8Array,
  password: string,
): Promise<Uint8Array | null> {
  if (blob.length < PWENC_BLOB_MIN_LEN) return null;
  for (let i = 0; i < MAGIC.length; i++) {
    if (blob[i] !== MAGIC[i]) return null;
  }
  let off = MAGIC.length;
  const salt = blob.slice(off, off + SALT_LEN);
  off += SALT_LEN;
  const iv = blob.slice(off, off + IV_LEN);
  off += IV_LEN;
  const ct = blob.slice(off);
  try {
    const key = await deriveKeyForSalt(password, salt);
    const aesKey = await crypto.subtle.importKey(
      "raw",
      key as BufferSource,
      { name: "AES-GCM" },
      false,
      ["decrypt"],
    );
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as BufferSource, tagLength: 128 },
      aesKey,
      ct as BufferSource,
    );
    return new Uint8Array(pt);
  } catch {
    return null;
  }
}
