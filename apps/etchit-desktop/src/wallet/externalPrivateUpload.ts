// SPDX-License-Identifier: AGPL-3.0-only
// External-signer **private** upload pipeline. Same wallet leg as
// public (extracted in `walletPayment.ts`); the difference is that
// prepare returns a data-map and finalize doesn't yield an address —
// the caller persists the data-map and identifies the etch by it.
//
// Pending-finalize: an in-memory record is saved after the payment
// clears so a hung finalize can be resumed in the same process. The
// record carries the metadata the resume needs to complete the same
// data-map encrypt + blob upload + privateAppend ceremony that the
// Private tab's `persistAndShow` does — without this the resume
// could finalize the chunks but never file the library entry.

import { invoke } from "@tauri-apps/api/core";

import {
  clearPending,
  markFinalizeFailed,
  newPendingId,
  savePending,
} from "./pendingEtches";
import {
  type PaymentDto,
  type Progress,
  runWalletPayment,
  txHashMap,
} from "./walletPayment";

interface PreparedPrivateEtch {
  upload_id: string;
  payments: PaymentDto[];
  total_amount: string;
  data_map: string;
}

export interface PrivateUploadResult {
  /** The data-map — caller persists this locally. Without it the
   *  chunks are unrecoverable. */
  dataMap: string;
  walletAddress: string;
  chunksStored: number;
  payTxHash: string;
}

/** Metadata threaded through so a resume can complete the same
 *  library write the original tab would have done. */
export interface PrivateUploadMeta {
  /** User-typed title — surfaced on the resume banner and used as
   *  the library entry's title. */
  label: string;
  /** Size of the original content in bytes, for the library entry. */
  sizeBytes: number;
  /** `"text"` for typed body, `"file"` for file / bundle. */
  kind: "text" | "file";
  /** Filename to surface in the library; required for `kind: "file"`. */
  originalFilename?: string;
}

/** End-to-end private etch via WalletConnect — in-memory bytes (text). */
export async function uploadPrivateViaWallet(
  data: Uint8Array,
  progress: Progress = () => {},
  meta: PrivateUploadMeta,
): Promise<PrivateUploadResult> {
  return runPrivatePipeline(
    { command: "prepare_private_etch", args: { data: Array.from(data) } },
    progress,
    meta,
  );
}

/** End-to-end private etch via WalletConnect — file path. ant-ffi
 *  streams the file from disk, no in-memory round-trip. */
export async function uploadPrivateFileViaWallet(
  path: string,
  progress: Progress = () => {},
  meta: PrivateUploadMeta,
): Promise<PrivateUploadResult> {
  return runPrivatePipeline(
    { command: "prepare_private_etch_file", args: { path } },
    progress,
    meta,
  );
}

/** Multi-file / folder private etch — Rust zips the paths (no
 *  compression) and ships the archive through the private path. */
export async function uploadPrivateFilesViaWallet(
  paths: string[],
  progress: Progress = () => {},
  meta: PrivateUploadMeta,
): Promise<PrivateUploadResult> {
  return runPrivatePipeline(
    { command: "prepare_private_etch_files", args: { paths } },
    progress,
    meta,
  );
}

interface PrepareInput {
  command:
    | "prepare_private_etch"
    | "prepare_private_etch_file"
    | "prepare_private_etch_files";
  args: Record<string, unknown>;
}

async function runPrivatePipeline(
  input: PrepareInput,
  progress: Progress,
  meta: PrivateUploadMeta,
): Promise<PrivateUploadResult> {
  progress("Collecting quotes from the network…");
  const prepared = await invoke<PreparedPrivateEtch>(input.command, input.args);
  const { payTxHash, walletAddress } = await runWalletPayment(
    prepared.payments,
    prepared.total_amount,
    progress,
  );

  const pendingId = newPendingId();
  savePending({
    id: pendingId,
    label: meta.label,
    uploadId: prepared.upload_id,
    payments: prepared.payments,
    payTxHash,
    payer: walletAddress,
    flow: {
      type: "private",
      dataMap: prepared.data_map,
      walletMode: "external",
      walletAddress,
      sizeBytes: meta.sizeBytes,
      kind: meta.kind,
      ...(meta.originalFilename ? { originalFilename: meta.originalFilename } : {}),
    },
    createdAt: Date.now(),
  });

  progress("Finalizing upload — pushing chunks to the network…");
  let result: { chunks_stored: number };
  try {
    result = await invoke<{ chunks_stored: number }>("finalize_private_etch", {
      uploadId: prepared.upload_id,
      txHashes: txHashMap(prepared.payments, payTxHash),
    });
  } catch (e) {
    markFinalizeFailed(pendingId);
    throw e;
  }
  clearPending(pendingId);
  return {
    dataMap: prepared.data_map,
    walletAddress,
    chunksStored: result.chunks_stored,
    payTxHash,
  };
}
