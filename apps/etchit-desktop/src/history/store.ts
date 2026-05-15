// Typed wrapper around the Rust history commands. The Tauri side owns
// the on-disk format; this module only handles the IPC.
//
// Mutations dispatch a `window` event so the History tab can refresh
// in real time even when the etch happened in another tab.

import { invoke } from "@tauri-apps/api/core";

/** Event fired after any successful history mutation. The History tab
 *  listens for this and re-renders, so etches landed from any other
 *  tab show up immediately. */
export const HISTORY_CHANGED_EVENT = "etchit:history-changed";

function dispatchChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(HISTORY_CHANGED_EVENT));
  }
}

export type HistoryKind = "text" | "file" | "blog" | "site";

export interface HistoryEntry {
  address: string;
  label: string;
  kind: HistoryKind;
  ts_ms: number;
  chunks_stored?: number;
}

/** Record one successful etch. Backend deduplicates by address (re-etching
 *  identical content yields the same address; the second append wins). */
export async function historyAppend(
  address: string,
  label: string,
  kind: HistoryKind,
  chunksStored?: number,
): Promise<HistoryEntry[]> {
  const entry: HistoryEntry = {
    address,
    label: label.trim() || "Untitled",
    kind,
    ts_ms: Date.now(),
    ...(chunksStored !== undefined ? { chunks_stored: chunksStored } : {}),
  };
  const result = await invoke<HistoryEntry[]>("history_append", { entry });
  dispatchChanged();
  return result;
}

/** Newest first. */
export async function historyLoad(): Promise<HistoryEntry[]> {
  return invoke<HistoryEntry[]>("history_load");
}

/** Idempotent — no-op if `address` isn't present. */
export async function historyDelete(address: string): Promise<HistoryEntry[]> {
  const result = await invoke<HistoryEntry[]>("history_delete", { address });
  dispatchChanged();
  return result;
}

export async function historyClear(): Promise<void> {
  await invoke<void>("history_clear");
  dispatchChanged();
}

/** Fail-soft wrapper for callers that just want to fire-and-forget the
 *  append from a success handler. A history-write failure must never
 *  reverse a successful etch — the address is already on the network.
 *  Surfaces errors through `console.warn` only. */
export function historyAppendBestEffort(
  address: string,
  label: string,
  kind: HistoryKind,
  chunksStored?: number,
): void {
  void historyAppend(address, label, kind, chunksStored).catch((e: unknown) => {
    console.warn("[history] append failed:", e);
  });
}
