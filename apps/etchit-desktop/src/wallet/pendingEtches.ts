// SPDX-License-Identifier: AGPL-3.0-only
// In-memory "pending finalize" store for external-signer uploads.
//
// Background: when WalletConnect's relay drops the signed-tx response
// after a reconnect, the on-chain `payForQuotes` clears but the
// frontend never gets the tx hash back. The user pays ANT for nothing,
// and the prepared upload (chunks held in ant-ffi's in-memory session
// map) is orphaned. This module gives us a same-session recovery path:
// the pipeline saves a record after `runWalletPayment` returns and
// clears it on finalize success. A surviving record means finalize
// never landed — the Resume banner picks it up and re-runs the
// finalize step with the saved `(uploadId, payments, payTxHash)`.
//
// Same-session only. The `uploadId` is a routing key in ant-ffi's
// `Client` object that does NOT survive process restart, so resume
// across launches isn't possible without re-paying. We accept that
// limitation in V1; the empirical failure mode is "the same process
// is still running, finalize just never came back".
//
// History note: the Internal-wallet path doesn't use prepare/finalize
// at all — it's a single Rust call — so it can't reach this state.

import { invoke } from "@tauri-apps/api/core";

import { historyAppendBestEffort } from "../history/store";
import { encryptBlob } from "../private/cipherBlob";
import { currentPassword } from "../private/passwordSession";
import { newEntryId, privateAppend } from "../private/store";

import { uploadBytesViaWallet } from "./externalUpload";
import type { PaymentDto } from "./walletPayment";

/** Fired whenever the pending set changes (save / clear). UI listens
 *  to refresh the resume banner. */
export const PENDING_CHANGED_EVENT = "etchit:pending-changed";

/** What completion looks like after the chunks-finalize step.
 *
 *  * `public`  — write a history entry under `historyKind`. The
 *    chunks-finalize call returns the network address.
 *  * `private` — re-run the data-map encrypt + blob-upload + library
 *    write that the Private tab's `persistAndShow` does. The chunks
 *    address from the original prepare (`dataMap`) is the recovery
 *    handle. */
export type PendingFlow =
  | { type: "public"; historyKind: "text" | "file" | "blog" | "site" }
  | {
      type: "private";
      dataMap: string;
      walletMode: "internal" | "external";
      walletAddress: string;
      sizeBytes: number;
      kind: "text" | "file";
      originalFilename?: string;
    };

export interface PendingEtch {
  id: string;
  /** Label the user gave the etch — surfaced on the resume banner so
   *  they can tell which upload they're being asked to resume. */
  label: string;
  uploadId: string;
  payments: PaymentDto[];
  payTxHash: string;
  payer: string;
  flow: PendingFlow;
  /** Unix ms. Newest first in `listPending`. */
  createdAt: number;
}

const entries = new Map<string, PendingEtch>();

/** Generate a unique id for a new pending record. */
export function newPendingId(): string {
  return crypto.randomUUID();
}

/** Add (or overwrite) a pending record. */
export function savePending(entry: PendingEtch): void {
  entries.set(entry.id, entry);
  emit();
}

/** Remove a pending record. Idempotent. */
export function clearPending(id: string): void {
  if (entries.delete(id)) emit();
}

/** Newest first. */
export function listPending(): PendingEtch[] {
  return [...entries.values()].sort((a, b) => b.createdAt - a.createdAt);
}

/** Subscribe to change events. Returns an unsubscribe function. */
export function onPendingChange(handler: () => void): () => void {
  window.addEventListener(PENDING_CHANGED_EVENT, handler);
  return () => window.removeEventListener(PENDING_CHANGED_EVENT, handler);
}

function emit(): void {
  window.dispatchEvent(new CustomEvent(PENDING_CHANGED_EVENT));
}

function txHashesFor(entry: PendingEtch): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of entry.payments) out[p.quote_hash] = entry.payTxHash;
  return out;
}

export interface ResumeResult {
  /** Network address of the resumed etch. For private resumes this
   *  is the chunks data-map (same handle the entry will be filed
   *  under in the library). */
  address: string;
  chunksStored: number;
}

/** Re-run the finalize step for a pending record, plus the same
 *  post-finalize bookkeeping the original tab would have done
 *  (history write for public; data-map encrypt + blob upload +
 *  privateAppend for private).
 *
 *  Throws on any failure; the pending record is left in place so the
 *  user can retry. The one degraded path is the data-map blob upload
 *  for private — if that fails we still write the library entry with
 *  the plaintext data-map as a fallback (matches `persistAndShow`'s
 *  same-named recovery in `private.ts`). */
export async function resumePending(id: string): Promise<ResumeResult> {
  const entry = entries.get(id);
  if (!entry) throw new Error("pending entry no longer in queue");

  const hashes = txHashesFor(entry);

  if (entry.flow.type === "public") {
    const result = await invoke<{ address: string; chunks_stored: number }>(
      "finalize_public_etch",
      { uploadId: entry.uploadId, txHashes: hashes },
    );
    historyAppendBestEffort(
      result.address,
      entry.label,
      entry.flow.historyKind,
      result.chunks_stored,
    );
    clearPending(id);
    return { address: result.address, chunksStored: result.chunks_stored };
  }

  const flow = entry.flow;
  const finalizeResult = await invoke<{ chunks_stored: number }>("finalize_private_etch", {
    uploadId: entry.uploadId,
    txHashes: hashes,
  });

  // Same data-map persistence ceremony as private.ts persistAndShow:
  // encrypt the data-map under the session passphrase, upload as a
  // public blob, fall back to plaintext data-map in the library entry
  // if the blob step fails (the user is told to backup-export to
  // recover offline).
  let enc_data_map_addr: string | undefined;
  let fallbackDataMap = "";
  try {
    const password = currentPassword();
    if (!password) throw new Error("session passphrase missing — pending entry can't complete privately");
    const dataMapBytes = new TextEncoder().encode(flow.dataMap);
    const blob = await encryptBlob(dataMapBytes, password);
    if (flow.walletMode === "external") {
      const r = await uploadBytesViaWallet(blob);
      enc_data_map_addr = r.address;
    } else {
      enc_data_map_addr = await invoke<string>("etch_bytes", { data: Array.from(blob) });
    }
  } catch (e) {
    fallbackDataMap = flow.dataMap;
    // eslint-disable-next-line no-console
    console.warn("[pending] data-map blob upload failed during resume:", e);
  }

  await privateAppend({
    id: newEntryId(),
    title: entry.label,
    data_map: fallbackDataMap,
    ...(enc_data_map_addr ? { enc_data_map_addr } : {}),
    size_bytes: flow.sizeBytes,
    wallet_mode: flow.walletMode,
    wallet_address: flow.walletAddress,
    chunks_stored: finalizeResult.chunks_stored,
    ts_ms: Date.now(),
    kind: flow.kind,
    ...(flow.originalFilename ? { original_filename: flow.originalFilename } : {}),
  });

  clearPending(id);
  return { address: flow.dataMap, chunksStored: finalizeResult.chunks_stored };
}
