// External-signer upload pipeline. Mirrors `uploadPublicBytes` from
// the previous desktop (`josh-clsn/etchit-desktop-old`) which proved
// the pattern works inside a Tauri WebView.
//
// Flow:
//
//   1. Call Rust `prepare_public_etch(data)` → upload_id + payments[]
//   2. Read ANT `allowance(user, VAULT)` over `eth_call`. If short,
//      pop the wallet to `approve(VAULT, SESSION_BUDGET_ATTO)` and
//      wait for confirmation.
//   3. Encode `payForQuotes(payments[])`, pop the wallet for the
//      payment tx, wait for confirmation.
//   4. Call Rust `finalize_public_etch(upload_id, { quoteHash: txHash })`
//      → returns the 64-hex address.
//
// Constants (vault, token, chain) come from `constants.ts` — Rust uses
// the same trio in `src-tauri/src/wallet.rs`.

import { invoke } from "@tauri-apps/api/core";
import { Interface, JsonRpcProvider, type Eip1193Provider } from "ethers";

import { currentAccount, currentProvider, waitForConnection } from "./appkit";
import {
  ANT_TOKEN_ADDRESS,
  ARBITRUM_CHAIN_ID,
  ARBITRUM_RPC,
  SESSION_BUDGET_ATTO,
  VAULT_ADDRESS,
} from "./constants";

interface PaymentDto {
  rewards_address: string;
  amount: string;
  quote_hash: string;
}
interface PreparedPublicEtch {
  upload_id: string;
  payments: PaymentDto[];
  total_amount: string;
}
interface PublicEtchResult {
  address: string;
  chunks_stored: number;
}

const ERC20_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];
const VAULT_ABI = [
  "function payForQuotes(tuple(address rewardsAddress, uint256 amount, bytes32 quoteHash)[] payments)",
];
const erc20Iface = new Interface(ERC20_ABI);
const vaultIface = new Interface(VAULT_ABI);

const rpc = new JsonRpcProvider(ARBITRUM_RPC, ARBITRUM_CHAIN_ID, { staticNetwork: true });

/** Optional progress reporter for the caller's UI. Called at each
 *  phase so Etch / Blogger / Website tabs can surface "Approve in
 *  wallet…" / "Waiting for confirmation…" etc. */
export type Progress = (message: string) => void;

export interface UploadResult {
  address: string;
  chunksStored: number;
  payTxHash: string;
}

interface PrepareInput {
  command: "prepare_public_etch" | "prepare_public_etch_text" | "prepare_public_etch_file";
  args: Record<string, unknown>;
}

/** End-to-end external-signer upload for arbitrary bytes already in JS
 *  (used by Blogger / Website which build the HTML in the frontend). */
export async function uploadBytesViaWallet(
  data: Uint8Array,
  progress: Progress = () => {},
): Promise<UploadResult> {
  return runPipeline({ command: "prepare_public_etch", args: { data: Array.from(data) } }, progress);
}

/** External-signer flow for a text etch — Rust builds the envelope. */
export async function uploadTextViaWallet(
  title: string,
  body: string,
  progress: Progress = () => {},
): Promise<UploadResult> {
  return runPipeline(
    { command: "prepare_public_etch_text", args: { title, body } },
    progress,
  );
}

/** External-signer flow for a file etch — Rust reads the file. */
export async function uploadFileViaWallet(
  path: string,
  progress: Progress = () => {},
): Promise<UploadResult> {
  return runPipeline({ command: "prepare_public_etch_file", args: { path } }, progress);
}

async function runPipeline(input: PrepareInput, progress: Progress): Promise<UploadResult> {
  progress("Connecting wallet…");
  let userAddress = await currentAccount();
  if (!userAddress) userAddress = await waitForConnection();
  const provider = await currentProvider();
  if (!provider) throw new Error("Wallet connected but no provider available.");

  progress("Collecting quotes from the network…");
  const prepared = await invoke<PreparedPublicEtch>(input.command, input.args);
  const totalAtto = BigInt(prepared.total_amount);

  await ensureArbitrumChain(provider);

  progress("Checking ANT allowance…");
  const allowanceData = erc20Iface.encodeFunctionData("allowance", [userAddress, VAULT_ADDRESS]);
  const allowanceHex = await rpc.call({ to: ANT_TOKEN_ADDRESS, data: allowanceData });
  const allowance = BigInt(allowanceHex);
  if (allowance < totalAtto) {
    progress("Approve ANT spending in your wallet…");
    const approveAmount = SESSION_BUDGET_ATTO > totalAtto ? SESSION_BUDGET_ATTO : totalAtto;
    const approveData = erc20Iface.encodeFunctionData("approve", [VAULT_ADDRESS, approveAmount]);
    const approveHash = await sendTx(provider, userAddress, ANT_TOKEN_ADDRESS, approveData);
    progress(`Waiting for approval confirmation (${shortTx(approveHash)})…`);
    const receipt = await rpc.waitForTransaction(approveHash);
    if (receipt?.status !== 1) throw new Error(`ANT approve reverted (${approveHash}).`);
  }

  progress("Sign payment in your wallet…");
  const vaultPayments = prepared.payments.map((p) => [
    withHex(p.rewards_address),
    BigInt(p.amount),
    withHex(p.quote_hash),
  ]);
  const payData = vaultIface.encodeFunctionData("payForQuotes", [vaultPayments]);
  const payTxHash = await sendTx(provider, userAddress, VAULT_ADDRESS, payData);
  progress(`Waiting for payment confirmation (${shortTx(payTxHash)})…`);
  const payReceipt = await rpc.waitForTransaction(payTxHash);
  if (payReceipt?.status !== 1) throw new Error(`payForQuotes reverted (${payTxHash}).`);

  progress("Finalizing upload — pushing chunks to the network…");
  const txHashes: Record<string, string> = {};
  for (const p of prepared.payments) txHashes[p.quote_hash] = payTxHash;
  const result = await invoke<PublicEtchResult>("finalize_public_etch", {
    uploadId: prepared.upload_id,
    txHashes,
  });
  return { address: result.address, chunksStored: result.chunks_stored, payTxHash };
}

async function ensureArbitrumChain(provider: Eip1193Provider): Promise<void> {
  // AppKit pins request() to its configured network (eip155:42161). If
  // the wallet's active session is on a different chain, the request
  // is rejected before it ever reaches the wallet. Try a permissioned
  // switch first; if the wallet doesn't know about Arbitrum One, fall
  // back to adding the chain. Either way, no-op when already correct.
  const hex = `0x${ARBITRUM_CHAIN_ID.toString(16)}`;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (e: unknown) {
    // 4902 = "chain not added" per EIP-3326.
    const code = (e as { code?: number }).code;
    if (code !== 4902) return;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: hex,
          chainName: "Arbitrum One",
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: [ARBITRUM_RPC],
          blockExplorerUrls: ["https://arbiscan.io"],
        },
      ],
    });
  }
}

async function sendTx(
  provider: Eip1193Provider,
  from: string,
  to: string,
  data: string,
): Promise<string> {
  return (await provider.request({
    method: "eth_sendTransaction",
    params: [{ from, to, data, value: "0x0" }],
  })) as string;
}

function withHex(s: string): string {
  return s.startsWith("0x") || s.startsWith("0X") ? s : `0x${s}`;
}

function shortTx(h: string): string {
  return `${h.slice(0, 10)}…`;
}
