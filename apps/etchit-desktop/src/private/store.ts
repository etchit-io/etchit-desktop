// Typed wrapper around the Rust private-entries store.

import { invoke } from "@tauri-apps/api/core";

/** Fired after any successful mutation so the Private tab can refresh
 *  without polling. */
export const PRIVATE_CHANGED_EVENT = "etchit:private-changed";

export type PrivateKind = "text" | "file";

export interface PrivateEntry {
  id: string;
  title: string;
  /** Legacy plaintext data-map (hex). Empty on entries written
   *  after the password-encryption rewrite; readers prefer
   *  `enc_data_map_addr` when present. */
  data_map: string;
  /** Public Autonomi address (64-hex) of the password-encrypted
   *  data-map blob. Fetch + decrypt with the session password to
   *  recover the data-map, then `fetch_private_data` to recover
   *  the original content. */
  enc_data_map_addr?: string;
  size_bytes: number;
  wallet_mode: "internal" | "external";
  wallet_address: string;
  chunks_stored: number;
  ts_ms: number;
  /** `"text"` or `"file"`. Older entries (before this field landed)
   *  default to `"text"` on the Rust side. */
  kind?: PrivateKind;
  /** Basename of the source file for `kind === "file"` entries. */
  original_filename?: string;
}

function dispatchChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(PRIVATE_CHANGED_EVENT));
  }
}

export async function privateLoad(): Promise<PrivateEntry[]> {
  return invoke<PrivateEntry[]>("private_load");
}

export async function privateAppend(entry: PrivateEntry): Promise<PrivateEntry[]> {
  const result = await invoke<PrivateEntry[]>("private_append", { entry });
  dispatchChanged();
  return result;
}

export async function privateDelete(id: string): Promise<PrivateEntry[]> {
  const result = await invoke<PrivateEntry[]>("private_delete", { id });
  dispatchChanged();
  return result;
}

export async function fetchPrivateData(dataMapHex: string): Promise<Uint8Array> {
  const arr = await invoke<number[]>("fetch_private_data", { dataMapHex });
  return Uint8Array.from(arr);
}

/** ~22-character random id (96 bits of entropy via 12 random bytes,
 *  base36). Used as the local identity of each private entry. */
export function newEntryId(): string {
  const buf = new Uint8Array(12);
  crypto.getRandomValues(buf);
  let n = 0n;
  for (const b of buf) n = (n << 8n) | BigInt(b);
  return n.toString(36);
}
