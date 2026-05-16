// Password session for the private-etch system.
//
// One source of truth across the app — every `encryptBlob` /
// `decryptBlob` call goes through `deriveKeyForSalt`, which uses
// whatever password the user typed earlier in the session.
//
// Two-level cache:
//   1. The raw password string itself (so subsequent unique salts
//      don't re-prompt the user, and so every new etch lands under
//      the same key as the rest of the library).
//   2. Per-salt derived keys (so PBKDF2's 600k iterations only run
//      once per unique salt per session — typical opens are then
//      pure AES-GCM, <1ms).
//
// The raw password is mirrored to the OS keychain so it survives
// app restarts (`loadStoredPassword` at boot, fire-and-forget
// persist on every set, fire-and-forget clear on every clear). The
// derived-key cache stays in-memory only.

import { invoke } from "@tauri-apps/api/core";

const PBKDF2_ITERATIONS = 600_000;
const KEY_LEN_BYTES = 32;

let sessionPassword: string | null = null;
const keyBySalt = new Map<string, Uint8Array>();

/** Returns the session password, or `null` if none is set. Pure
 *  read; never prompts. Use [`requestPassword`] when you might
 *  need to ask the user. */
export function currentPassword(): string | null {
  return sessionPassword;
}

/** Set the session password. Caches in memory and mirrors to the OS
 *  keychain so the next app launch starts decrypted. The keychain
 *  write is fire-and-forget — if it fails (no keychain available),
 *  the in-memory session still works for this run. */
export function setSessionPassword(password: string): void {
  sessionPassword = password;
  // Don't preemptively clear the derived-key cache — keys derived
  // under the old password would AEAD-fail on the new one anyway,
  // so they'd evict themselves. Keeping them lets a user type the
  // same password back in mid-session without re-paying PBKDF2.
  void invoke("store_private_passphrase", { passphrase: password }).catch(() => {});
}

/** Forget the password and every cached derived key, in memory and
 *  in the OS keychain. The keychain delete is fire-and-forget. */
export function clearPasswordSession(): void {
  sessionPassword = null;
  keyBySalt.clear();
  void invoke("clear_private_passphrase").catch(() => {});
}

let loadPromise: Promise<void> | null = null;

/** Hydrate the in-memory session from the keychain. Memoised — fires
 *  once and every subsequent call returns the same promise, so it's
 *  safe to call from app startup AND from `ensurePassword` to gate
 *  the create-modal on a finished hydrate. If the keychain has no
 *  entry (fresh install) or any backend failure occurs, leaves the
 *  session empty so the user gets the usual create / enter prompt
 *  on first private use. */
export function loadStoredPassword(): Promise<void> {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const stored = await invoke<string | null>("get_private_passphrase");
      if (stored) sessionPassword = stored;
    } catch {
      // ignore — fresh prompt path
    }
  })();
  return loadPromise;
}

/** Derive (or fetch the cached) AES key for a given `(password,
 *  salt)` pair. PBKDF2-HMAC-SHA256, 600k iterations, 256-bit
 *  output. */
export async function deriveKeyForSalt(
  password: string,
  salt: Uint8Array,
): Promise<Uint8Array> {
  const cacheKey = `${password.length}:${bytesToHex(salt)}`;
  const cached = keyBySalt.get(cacheKey);
  if (cached) return cached;

  const pwKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password) as BufferSource,
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: salt as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    pwKey,
    KEY_LEN_BYTES * 8,
  );
  const key = new Uint8Array(bits);
  keyBySalt.set(cacheKey, key);
  return key;
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
