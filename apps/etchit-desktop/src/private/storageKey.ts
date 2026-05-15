// At-rest storage key — derived from a wallet signature over the
// frozen `SIGN_MESSAGE_PRIVATE`, scoped via HKDF info to be distinct
// from the chainmark key derived from the *other* frozen message.
//
// Both wallet modes are supported:
//   * External (WalletConnect): pop the wallet via AppKit, get
//     `personal_sign` over the bytes.
//   * Internal (keychain): hand the bytes to the Rust signer
//     (`personal_sign_with_keychain`) so the private key never
//     crosses the Tauri IPC boundary.
//
// Cache: 32-byte derived key persisted to localStorage, keyed by
// wallet address (or by `keychain:<fingerprint>` when the user is in
// internal mode and has no external account yet). Matches the
// chainmark-key caching strategy — same trust model, same trade-off.

import { invoke } from "@tauri-apps/api/core";
import type { Eip1193Provider } from "ethers";

import { currentAccount, currentProvider, waitForConnection } from "../wallet/appkit";
import { loadWalletMode } from "../wallet/mode";

import { HKDF_INFO_PRIVATE_STORAGE, SIGN_MESSAGE_PRIVATE, SIGN_MESSAGE_PRIVATE_SHA256 } from "./spec";

const STORAGE_PREFIX = "etchit.privateStorageKey.";
const KEY_LEN_BYTES = 32;
const SIG_LEN_BYTES = 65;

/** Resolves to the 32-byte AEAD key + a stable identity string for
 *  the wallet that produced it. The identity is what the caller
 *  records on the entry so we know which wallet's library it belongs
 *  to (and which key to re-derive on read). */
export interface StorageKey {
  key: Uint8Array;
  /** Wallet address (external) or a `keychain:` synthetic identity
   *  (internal). Stored on each private entry so we know which key to
   *  use on read. */
  ownerId: string;
}

/** Derive — or load cached — the private-storage key. Pops the
 *  wallet exactly once per `ownerId` per device. */
export async function getOrDeriveStorageKey(): Promise<StorageKey> {
  await assertSignMessagePinned();
  const mode = loadWalletMode();
  if (mode === "external") return getExternalStorageKey();
  return getInternalStorageKey();
}

async function getExternalStorageKey(): Promise<StorageKey> {
  let address = await currentAccount();
  if (!address) address = await waitForConnection();
  const ownerId = address.toLowerCase();
  const cached = loadCached(ownerId);
  if (cached) return { key: cached, ownerId };

  const provider = await currentProvider();
  if (!provider) throw new Error("wallet provider unavailable");

  const sig = await externalPersonalSign(provider, address);
  const key = await deriveFromSig(sig);
  saveCached(ownerId, key);
  return { key, ownerId };
}

async function getInternalStorageKey(): Promise<StorageKey> {
  // The keychain key itself is the identity here. We hash it (via
  // the wallet info command) to avoid keying localStorage by raw
  // private-key fingerprint. The Rust signer command is the only
  // path that touches the key; from JS we just see the signature.
  const info = await invoke<{ address: string } | null>("internal_wallet_info");
  if (!info) {
    throw new Error("no keychain wallet set — open Settings → Advanced to paste a key");
  }
  const ownerId = `keychain:${info.address.toLowerCase()}`;
  const cached = loadCached(ownerId);
  if (cached) return { key: cached, ownerId };

  const messageBytes = Array.from(new TextEncoder().encode(SIGN_MESSAGE_PRIVATE));
  const sig = await invoke<string>("personal_sign_with_keychain", { message: messageBytes });
  const key = await deriveFromSig(sig);
  saveCached(ownerId, key);
  return { key, ownerId };
}

async function externalPersonalSign(
  provider: Eip1193Provider,
  address: string,
): Promise<string> {
  const messageHex = "0x" + bytesToHex(new TextEncoder().encode(SIGN_MESSAGE_PRIVATE));
  const sig = (await provider.request({
    method: "personal_sign",
    params: [messageHex, address],
  })) as string;
  return sig;
}

/** Take r||s (64 bytes) from the 65-byte sig and run HKDF-SHA256
 *  with the private-storage info scope. */
async function deriveFromSig(sigHex: string): Promise<Uint8Array> {
  const body = sigHex.startsWith("0x") ? sigHex.slice(2) : sigHex;
  if (body.length !== SIG_LEN_BYTES * 2) {
    throw new Error(`expected 65-byte signature, got ${body.length / 2}`);
  }
  const full = hexToBytes(body);
  const ikm = full.slice(0, 64); // r || s
  const importedIkm = await crypto.subtle.importKey(
    "raw",
    ikm as BufferSource,
    { name: "HKDF" },
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(HKDF_INFO_PRIVATE_STORAGE),
    },
    importedIkm,
    KEY_LEN_BYTES * 8,
  );
  return new Uint8Array(bits);
}

// ── localStorage cache ──────────────────────────────────────────

function loadCached(ownerId: string): Uint8Array | null {
  if (typeof localStorage === "undefined") return null;
  const hex = localStorage.getItem(STORAGE_PREFIX + ownerId);
  return hex ? hexToBytes(hex) : null;
}

function saveCached(ownerId: string, key: Uint8Array): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(STORAGE_PREFIX + ownerId, bytesToHex(key));
}

export function clearCachedStorageKey(ownerId: string): void {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(STORAGE_PREFIX + ownerId);
}

// ── Boot-time pin check ─────────────────────────────────────────

async function assertSignMessagePinned(): Promise<void> {
  const bytes = new TextEncoder().encode(SIGN_MESSAGE_PRIVATE);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  const got = bytesToHex(digest);
  if (got !== SIGN_MESSAGE_PRIVATE_SHA256) {
    throw new Error(
      `SIGN_MESSAGE_PRIVATE bytes drifted from spec (got ${got}, expected ${SIGN_MESSAGE_PRIVATE_SHA256}). ` +
        "Every existing private etch on this device is now undecryptable. Revert the message or bump the protocol version with a migration.",
    );
  }
}

// ── hex helpers ─────────────────────────────────────────────────

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function hexToBytes(s: string): Uint8Array {
  if (s.length % 2 !== 0) throw new Error("odd hex length");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
