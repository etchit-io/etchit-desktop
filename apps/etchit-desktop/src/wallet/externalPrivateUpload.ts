// External-signer **private** upload pipeline. Same wallet leg as
// public (extracted in `walletPayment.ts`); the difference is that
// prepare returns a data-map and finalize doesn't yield an address —
// the caller persists the data-map and identifies the etch by it.

import { invoke } from "@tauri-apps/api/core";

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

/** End-to-end private etch via WalletConnect — in-memory bytes (text). */
export async function uploadPrivateViaWallet(
  data: Uint8Array,
  progress: Progress = () => {},
): Promise<PrivateUploadResult> {
  return runPrivatePipeline(
    { command: "prepare_private_etch", args: { data: Array.from(data) } },
    progress,
  );
}

/** End-to-end private etch via WalletConnect — file path. ant-ffi
 *  streams the file from disk, no in-memory round-trip. */
export async function uploadPrivateFileViaWallet(
  path: string,
  progress: Progress = () => {},
): Promise<PrivateUploadResult> {
  return runPrivatePipeline(
    { command: "prepare_private_etch_file", args: { path } },
    progress,
  );
}

/** Multi-file / folder private etch — Rust zips the paths (no
 *  compression) and ships the archive through the private path. */
export async function uploadPrivateFilesViaWallet(
  paths: string[],
  progress: Progress = () => {},
): Promise<PrivateUploadResult> {
  return runPrivatePipeline(
    { command: "prepare_private_etch_files", args: { paths } },
    progress,
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
): Promise<PrivateUploadResult> {
  progress("Collecting quotes from the network…");
  const prepared = await invoke<PreparedPrivateEtch>(input.command, input.args);
  const { payTxHash, walletAddress } = await runWalletPayment(
    prepared.payments,
    prepared.total_amount,
    progress,
  );

  progress("Finalizing upload — pushing chunks to the network…");
  const result = await invoke<{ chunks_stored: number }>("finalize_private_etch", {
    uploadId: prepared.upload_id,
    txHashes: txHashMap(prepared.payments, payTxHash),
  });
  return {
    dataMap: prepared.data_map,
    walletAddress,
    chunksStored: result.chunks_stored,
    payTxHash,
  };
}
