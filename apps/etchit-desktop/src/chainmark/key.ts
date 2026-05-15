// Chainmark key cache.
//
// The first time we need a chainmark key for a given wallet, we pop
// the wallet for `personal_sign` over `SIGN_MESSAGE`, take r||s from
// the 65-byte signature, and run HKDF-SHA256. Subsequent calls in the
// same session — and across re-launches, since the cache lives in
// localStorage — return the cached 32-byte key, no wallet prompt.
//
// §4.4 of the spec says clients SHOULD cache encrypted-at-rest in
// the OS keychain. V1 stores the key plaintext in localStorage; the
// app data dir is per-user and the threat model treats local
// processes as trusted. V1.1 will move it into the OS keychain
// alongside the wallet key path.

import type { Eip1193Provider } from "ethers";

import { deriveKey, IKM_LEN } from "./crypto";
import { SIGN_MESSAGE, SIGN_MESSAGE_SHA256 } from "./spec";

const STORAGE_PREFIX = "etchit.chainmarkKey.";

/** Boot-time sanity check: if SIGN_MESSAGE has drifted from the
 *  pinned hash, refuse to operate. This guards against an upstream
 *  edit silently changing the derived key and breaking every existing
 *  user's chainmark sync. Called from any entry point that derives a
 *  key. */
async function assertSignMessagePinned(): Promise<void> {
  const bytes = new TextEncoder().encode(SIGN_MESSAGE);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  let hex = "";
  for (const b of digest) hex += b.toString(16).padStart(2, "0");
  if (hex !== SIGN_MESSAGE_SHA256) {
    throw new Error(
      `SIGN_MESSAGE bytes drifted from spec (got ${hex}, expected ${SIGN_MESSAGE_SHA256}). ` +
        "Chainmark cross-device sync is broken. Revert the message or bump the protocol version.",
    );
  }
}

/** Read a cached key for `wallet` (lowercase 0x-prefixed address)
 *  or `null` if none exists. */
export function loadCachedKey(wallet: string): Uint8Array | null {
  if (typeof localStorage === "undefined") return null;
  const k = wallet.toLowerCase();
  const hex = localStorage.getItem(STORAGE_PREFIX + k);
  if (!hex) return null;
  return fromHex(hex);
}

/** Persist a derived key for `wallet`. */
export function saveCachedKey(wallet: string, key: Uint8Array): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(STORAGE_PREFIX + wallet.toLowerCase(), toHex(key));
}

/** Drop the cached key for `wallet`. Used when the user explicitly
 *  rotates / disconnects, or when AEAD verification reveals the
 *  current key is stale. */
export function clearCachedKey(wallet: string): void {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(STORAGE_PREFIX + wallet.toLowerCase());
}

/** Derive the chainmark key for the connected WalletConnect wallet,
 *  caching on success. Pops the wallet for `personal_sign` exactly
 *  once per wallet per device. Throws if the user rejects, the
 *  wallet returns a malformed signature, or the IKM extraction
 *  fails. */
export async function getOrDeriveKey(
  wallet: string,
  provider: Eip1193Provider,
): Promise<Uint8Array> {
  const cached = loadCachedKey(wallet);
  if (cached) return cached;

  await assertSignMessagePinned();

  // EIP-191 personal_sign: hex-encode the message; let the wallet
  // apply the `\x19Ethereum Signed Message:\n<len>` prefix per
  // EIP-191 §6.b (clients MUST NOT pre-prefix per spec §4.1).
  const messageHex = "0x" + toHex(new TextEncoder().encode(SIGN_MESSAGE));
  const sigHex = (await provider.request({
    method: "personal_sign",
    params: [messageHex, wallet],
  })) as string;

  const ikm = extractIkm(sigHex);
  const key = await deriveKey(ikm);
  saveCachedKey(wallet, key);
  return key;
}

/** Pull r||s (64 bytes) out of a `0x`-prefixed 65-byte
 *  `personal_sign` signature. Drops the recovery byte `v`. */
function extractIkm(sigHex: string): Uint8Array {
  const body = sigHex.startsWith("0x") ? sigHex.slice(2) : sigHex;
  if (body.length !== 130) {
    throw new Error(`expected 65-byte signature, got ${body.length / 2}`);
  }
  const full = fromHex(body);
  if (full.length !== 65) {
    throw new Error(`expected 65-byte signature, got ${full.length}`);
  }
  // r || s = first 64 bytes; v (recovery) is the 65th.
  const ikm = full.slice(0, IKM_LEN);
  return ikm;
}

function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

function fromHex(s: string): Uint8Array {
  if (s.length % 2 !== 0) throw new Error("odd hex length");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
