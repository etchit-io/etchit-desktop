// Backup-file format constants. The on-disk Encrypt… / Import…
// path keeps the existing magic + PBKDF2 iteration count so backups
// made by older builds (or by the Android `BackupCrypto.kt`) still
// round-trip.

/** Magic header — 17 bytes including the trailing newline. Same
 *  bytes as mobile's `BackupCrypto.BACKUP_MAGIC`. */
export const BACKUP_MAGIC = "ETCHIT_BACKUP_v1\n";

/** PBKDF2-HMAC-SHA256 iteration count. Tuned with mobile — about
 *  ~250 ms on a 2020-era phone, ~50 ms on a desktop. */
export const BACKUP_PBKDF2_ITERATIONS = 600_000;

export const BACKUP_SALT_LEN = 16;
export const BACKUP_IV_LEN = 12;

/** Minimum password length the UI enforces for the custom-password
 *  fallback. Diceware paths bypass this — six BIP-39 words is 66
 *  bits regardless. */
export const MIN_BACKUP_PASSWORD_LEN = 8;
