// External-signer **public** upload pipeline. Uses the shared
// `runWalletPayment` helper for the wallet leg; this module only owns
// the prepare / finalize commands specific to public etches.

import { invoke } from "@tauri-apps/api/core";

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

/** End-to-end external-signer public upload for arbitrary bytes —
 *  used by Blogger / Website (HTML is built in JS). */
export async function uploadBytesViaWallet(
  data: Uint8Array,
  progress: Progress = () => {},
): Promise<UploadResult> {
  return runPipeline(
    { command: "prepare_public_etch", args: { data: Array.from(data) } },
    progress,
  );
}

/** Text etch — Rust ships the raw UTF-8 body bytes. */
export async function uploadTextViaWallet(
  body: string,
  progress: Progress = () => {},
): Promise<UploadResult> {
  return runPipeline(
    { command: "prepare_public_etch_text", args: { body } },
    progress,
  );
}

/** File etch — Rust reads the file. */
export async function uploadFileViaWallet(
  path: string,
  progress: Progress = () => {},
): Promise<UploadResult> {
  return runPipeline(
    { command: "prepare_public_etch_file", args: { path } },
    progress,
  );
}

/** Multi-file / folder etch — Rust zips the paths (no compression)
 *  and uploads the resulting archive as one. */
export async function uploadFilesViaWallet(
  paths: string[],
  progress: Progress = () => {},
): Promise<UploadResult> {
  return runPipeline(
    { command: "prepare_public_etch_files", args: { paths } },
    progress,
  );
}

async function runPipeline(input: PrepareInput, progress: Progress): Promise<UploadResult> {
  progress("Collecting quotes from the network…");
  const prepared = await invoke<PreparedPublicEtch>(input.command, input.args);
  const { payTxHash, walletAddress } = await runWalletPayment(
    prepared.payments,
    prepared.total_amount,
    progress,
  );

  progress("Finalizing upload — pushing chunks to the network…");
  const result = await invoke<PublicEtchResult>("finalize_public_etch", {
    uploadId: prepared.upload_id,
    txHashes: txHashMap(prepared.payments, payTxHash),
  });
  return {
    address: result.address,
    chunksStored: result.chunks_stored,
    payTxHash,
    walletAddress,
  };
}
