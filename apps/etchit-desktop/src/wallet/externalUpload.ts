// SPDX-License-Identifier: AGPL-3.0-only
// External-signer **public** upload pipeline. Uses the shared
// `runWalletPayment` helper for the wallet leg; this module only owns
// the prepare / finalize commands specific to public etches.
//
// Pending-finalize: after the payment clears we stash an in-memory
// pending record (see `pendingEtches.ts`) so a hung finalize can be
// resumed. Callers opt in by passing `pending`; the data-map blob
// upload during private-etch persistence passes `null` because that
// hang is bounded by the wallet-action banner timeout and the private
// flow's existing plaintext fallback.

import { invoke } from "@tauri-apps/api/core";

import {
  clearPending,
  markFinalizeFailed,
  newPendingId,
  savePending,
  type PendingFlow,
} from "./pendingEtches";
import {
  type PaymentDto,
  type Progress,
  runWalletPayment,
  txHashMap,
} from "./walletPayment";

interface PreparedPublicEtch {
  upload_id: string;
  payments: PaymentDto[];
  total_amount: string;
}
interface PublicEtchResult {
  address: string;
  chunks_stored: number;
}

interface PrepareInput {
  command:
    | "prepare_public_etch"
    | "prepare_public_etch_text"
    | "prepare_public_etch_file"
    | "prepare_public_etch_files";
  args: Record<string, unknown>;
}

export interface UploadResult {
  address: string;
  chunksStored: number;
  payTxHash: string;
  walletAddress: string;
}

/** Caller hint for the pending-finalize record. `null` opts out (used
 *  by the data-map blob upload nested inside the private pipeline —
 *  its hang is bounded by the wallet-action banner timeout and would
 *  surface as a misleading public entry in the resume banner). */
export type PublicPending =
  | { label: string; historyKind: "text" | "file" | "blog" | "site" }
  | null;

/** End-to-end external-signer public upload for arbitrary bytes —
 *  used by Blogger / Website (HTML is built in JS), and by the
 *  private pipeline for the encrypted data-map blob. */
export async function uploadBytesViaWallet(
  data: Uint8Array,
  progress: Progress = () => {},
  pending: PublicPending = null,
): Promise<UploadResult> {
  return runPipeline(
    { command: "prepare_public_etch", args: { data: Array.from(data) } },
    progress,
    pending,
  );
}

/** Text etch — Rust ships the raw UTF-8 body bytes. */
export async function uploadTextViaWallet(
  body: string,
  progress: Progress = () => {},
  label = "",
): Promise<UploadResult> {
  return runPipeline(
    { command: "prepare_public_etch_text", args: { body } },
    progress,
    label ? { label, historyKind: "text" } : null,
  );
}

/** File etch — Rust reads the file. */
export async function uploadFileViaWallet(
  path: string,
  progress: Progress = () => {},
  label = "",
): Promise<UploadResult> {
  return runPipeline(
    { command: "prepare_public_etch_file", args: { path } },
    progress,
    label ? { label, historyKind: "file" } : null,
  );
}

/** Multi-file / folder etch — Rust zips the paths (no compression)
 *  and uploads the resulting archive as one. */
export async function uploadFilesViaWallet(
  paths: string[],
  progress: Progress = () => {},
  label = "",
): Promise<UploadResult> {
  return runPipeline(
    { command: "prepare_public_etch_files", args: { paths } },
    progress,
    label ? { label, historyKind: "file" } : null,
  );
}

async function runPipeline(
  input: PrepareInput,
  progress: Progress,
  pending: PublicPending,
): Promise<UploadResult> {
  progress("Collecting quotes from the network…");
  const prepared = await invoke<PreparedPublicEtch>(input.command, input.args);
  const { payTxHash, walletAddress } = await runWalletPayment(
    prepared.payments,
    prepared.total_amount,
    progress,
  );

  let pendingId: string | null = null;
  if (pending) {
    const flow: PendingFlow = { type: "public", historyKind: pending.historyKind };
    pendingId = newPendingId();
    savePending({
      id: pendingId,
      label: pending.label,
      uploadId: prepared.upload_id,
      payments: prepared.payments,
      payTxHash,
      payer: walletAddress,
      flow,
      createdAt: Date.now(),
    });
  }

  progress("Finalizing upload — pushing chunks to the network…");
  let result: PublicEtchResult;
  try {
    result = await invoke<PublicEtchResult>("finalize_public_etch", {
      uploadId: prepared.upload_id,
      txHashes: txHashMap(prepared.payments, payTxHash),
    });
  } catch (e) {
    // Reveal the pending entry so the resume banner picks it up —
    // it stayed hidden while finalize was in flight.
    if (pendingId) markFinalizeFailed(pendingId);
    throw e;
  }
  if (pendingId) clearPending(pendingId);
  return {
    address: result.address,
    chunksStored: result.chunks_stored,
    payTxHash,
    walletAddress,
  };
}
