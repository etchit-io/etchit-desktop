// In-memory password session for the private-etch system.
//
// One source of truth across the app — every `encryptBlob` /
// `decryptBlob` call goes through `deriveKeyForSalt`, which uses
// whatever password the user typed earlier in the session.
//
// Two-level cache:
//   1. The raw password string itself (so subsequent unique salts
//      don't re-prompt the user).
//   2. Per-salt derived keys (so PBKDF2's 600k iterations only run
//      once per unique salt per session — typical opens are then
//      pure AES-GCM, <1ms).
//
// Neither layer persists across app restarts. If the user wants
// passwordless re-opens, that's a future "OS-keychain-cache the
// session key" feature.

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

/** Set the in-memory session password. Called after the user
 *  successfully types one into the modal. */
export function setSessionPassword(password: string): void {
  sessionPassword = password;
  // Don't preemptively clear the derived-key cache — keys derived
  // under the old password would AEAD-fail on the new one anyway,
  // so they'd evict themselves. Keeping them lets a user type the
  // same password back in mid-session without re-paying PBKDF2.
}

/** Forget the password and every cached derived key. Wire to a
 *  manual "lock library" affordance once we add one; auto-called on
 *  no-current-user. */
export function clearPasswordSession(): void {
  sessionPassword = null;
  keyBySalt.clear();
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
