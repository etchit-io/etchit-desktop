// Frozen cross-client constants for private-etch encryption.
//
// Two distinct cryptographic surfaces, each with its own frozen byte
// recipe. Edits to either set silently make existing user libraries
// undecryptable — bump version + add a migration before touching.
//
// 1. At-rest (per-data-map): wallet-signature-derived AEAD key,
//    HKDF-SHA256 with a private-storage-scoped `info`. Encrypts every
//    data-map sitting in `private_etches.json`.
// 2. Backup (cross-device, password): PBKDF2-HMAC-SHA256(600k) →
//    AES-256-GCM. Mirrors mobile's `BackupCrypto.kt` byte format so a
//    backup created on either platform round-trips.

// ── At-rest layer ────────────────────────────────────────────────

/** EIP-191 personal_sign message that derives the private-storage
 *  key. 188 UTF-8 bytes; SHA-256 pinned below. */
export const SIGN_MESSAGE_PRIVATE =
  "etchit private storage v1\n\n" +
  "Sign this message to derive the key that encrypts and decrypts " +
  "your private etches on this device. This signature does NOT " +
  "authorize any transaction or transfer.";

/** Defence-in-depth pin for `SIGN_MESSAGE_PRIVATE`. Any byte edit
 *  changes this hash; the boot-time check (`assertSignMessagePinned`
 *  in storageKey.ts) refuses to operate if it drifts. */
export const SIGN_MESSAGE_PRIVATE_SHA256 =
  "761f194f8756aba672cd7c502a5a3aaf2d4908c5cf9420a702090d4992febc7d";

/** HKDF info for the at-rest AEAD key — distinct from the chainmark
 *  info so the same wallet signature derives a *different* key for
 *  each purpose. */
export const HKDF_INFO_PRIVATE_STORAGE = "etchit-private-storage/v1/data-map-key";

// ── Backup layer ─────────────────────────────────────────────────

/** Magic header — 17 bytes including the trailing newline. Same
 *  bytes as mobile's `BackupCrypto.BACKUP_MAGIC`. */
export const BACKUP_MAGIC = "ETCHIT_BACKUP_v1\n";

/** PBKDF2-HMAC-SHA256 iteration count. Tuned with mobile — about
 *  ~250 ms on a 2020-era phone, ~50 ms on a desktop. Tradeoff:
 *  higher = stronger, but you wait that long every export/import. */
export const BACKUP_PBKDF2_ITERATIONS = 600_000;

export const BACKUP_SALT_LEN = 16;
export const BACKUP_IV_LEN = 12;

/** Minimum password length the UI enforces before letting the user
 *  export. The 6-word diceware path generates 66 bits of entropy
 *  regardless; this guards the "custom password" fallback. */
export const MIN_BACKUP_PASSWORD_LEN = 8;
