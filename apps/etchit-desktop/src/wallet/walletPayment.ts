// Shared wallet-payment leg used by both public and private external
// uploads. Caller does the prepare-side invoke (which differs between
// public and private), hands the resulting payments + total here, and
// receives the on-chain pay tx hash to thread into its finalize call.

import { Contract, Interface, JsonRpcProvider, type Eip1193Provider } from "ethers";

import { currentAccount, currentProvider, waitForConnection } from "./appkit";
import { formatToken, shortHexAddress } from "./balance";
import {
  ANT_TOKEN_ADDRESS,
  ARBITRUM_CHAIN_ID,
  ARBITRUM_RPC,
  SESSION_BUDGET_ATTO,
  VAULT_ADDRESS,
} from "./constants";
import { hideWalletActionBanner, showWalletActionBanner } from "./walletActionBanner";

export interface PaymentDto {
  rewards_address: string;
  amount: string;
  quote_hash: string;
}

export type Progress = (message: string) => void;

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

export interface WalletPaymentResult {
  payTxHash: string;
  walletAddress: string;
}

/** Run the approve + payForQuotes leg of an external upload. Opens
 *  the wallet modal if no session is connected. Throws with a
 *  human-readable message on any leg failure. */
export async function runWalletPayment(
  payments: PaymentDto[],
  totalAmount: string,
  progress: Progress,
): Promise<WalletPaymentResult> {
  progress("Connecting wallet…");
  let userAddress = await currentAccount();
  if (!userAddress) userAddress = await waitForConnection();
  const provider = await currentProvider();
  if (!provider) throw new Error("Wallet connected but no provider available.");

  await ensureArbitrumChain(provider);

  const totalAtto = BigInt(totalAmount);

  // Pre-flight balance check. The on-chain `payForQuotes` revert is
  // the worst onboarding moment — the user has signed 2-3 prompts
  // and finally hits "payForQuotes reverted (0x…)" with no idea what
  // it means. Catching insufficient ANT here gives a readable
  // message before the wallet even pops.
  progress("Checking ANT balance…");
  await ensureSufficientAnt(userAddress, totalAtto);

  progress("Checking ANT allowance…");
  const allowanceData = erc20Iface.encodeFunctionData("allowance", [userAddress, VAULT_ADDRESS]);
  const allowanceHex = await rpc.call({ to: ANT_TOKEN_ADDRESS, data: allowanceData });
  const allowance = BigInt(allowanceHex);
  if (allowance < totalAtto) {
    progress("Approve ANT spending in your wallet…");
    const approveAmount = SESSION_BUDGET_ATTO > totalAtto ? SESSION_BUDGET_ATTO : totalAtto;
    const approveData = erc20Iface.encodeFunctionData("approve", [VAULT_ADDRESS, approveAmount]);
    let approveHash: string;
    try {
      approveHash = await waitForSignature(
        sendTx(provider, userAddress, ANT_TOKEN_ADDRESS, approveData),
        "Open your wallet app — approve ANT spending. etch/it is waiting on your signature.",
      );
    } finally {
      hideWalletActionBanner();
    }
    progress(`Waiting for approval confirmation (${shortTx(approveHash)})…`);
    const receipt = await rpc.waitForTransaction(approveHash);
    if (receipt?.status !== 1) {
      throw new Error(
        `ANT approval failed on-chain (tx ${approveHash}). Often this means the wallet's ETH was just spent on something else — check the wallet for the failing tx.`,
      );
    }
  }

  progress("Sign payment in your wallet…");
  const vaultPayments = payments.map((p) => [
    withHex(p.rewards_address),
    BigInt(p.amount),
    withHex(p.quote_hash),
  ]);
  const payData = vaultIface.encodeFunctionData("payForQuotes", [vaultPayments]);
  let payTxHash: string;
  try {
    payTxHash = await waitForSignature(
      sendTx(provider, userAddress, VAULT_ADDRESS, payData),
      "Open your wallet app — sign the payment. etch/it is waiting on your signature.",
    );
  } finally {
    hideWalletActionBanner();
  }
  progress(`Waiting for payment confirmation (${shortTx(payTxHash)})…`);
  const payReceipt = await rpc.waitForTransaction(payTxHash);
  if (payReceipt?.status !== 1) {
    throw new Error(
      `On-chain payment reverted (tx ${payTxHash}). Usually means ANT balance went below the quote between the pre-flight check and the send — refund the wallet and retry.`,
    );
  }

  return { payTxHash, walletAddress: userAddress };
}

const ANT_ERC20_ABI = ["function balanceOf(address owner) view returns (uint256)"];
const antContract = new Contract(ANT_TOKEN_ADDRESS, ANT_ERC20_ABI, rpc);

async function ensureSufficientAnt(address: string, neededAtto: bigint): Promise<void> {
  let balance: bigint;
  try {
    balance = await (antContract.balanceOf(address) as Promise<bigint>);
  } catch (e: unknown) {
    // Balance lookup failed — don't block the flow on a transient
    // RPC blip; the on-chain check still applies.
    // eslint-disable-next-line no-console
    console.warn("[wallet] balance pre-check failed:", e);
    return;
  }
  if (balance >= neededAtto) return;
  const have = formatToken(balance.toString());
  const need = formatToken(neededAtto.toString());
  throw new Error(
    `Not enough ANT in ${shortHexAddress(address)} — this etch needs ${need} ANT but the wallet only has ${have} ANT on Arbitrum One. Top it up and retry.`,
  );
}

/** Map the payments list into the `{quote_hash: tx_hash}` form
 *  Rust expects for the finalize step. */
export function txHashMap(payments: PaymentDto[], payTxHash: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of payments) out[p.quote_hash] = payTxHash;
  return out;
}

async function ensureArbitrumChain(provider: Eip1193Provider): Promise<void> {
  // AppKit pins request() to its configured network. If the wallet's
  // active session is on a different chain, the request is rejected
  // before reaching the wallet — switch first, fall back to add for
  // wallets that don't know about Arbitrum One yet.
  const hex = `0x${ARBITRUM_CHAIN_ID.toString(16)}`;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (e: unknown) {
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

/** Pop the wallet-action banner with a Cancel button, race the
 *  signature against a 120s timeout. Resolves with the tx hash,
 *  rejects on user cancel, wallet rejection, or timeout. */
async function waitForSignature(
  txPromise: Promise<string>,
  bannerMsg: string,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };
    const timeoutId = window.setTimeout(() => {
      settle(() => reject(new Error("wallet signing timed out after 2 minutes")));
    }, 120_000);
    showWalletActionBanner(bannerMsg, () => {
      settle(() => {
        window.clearTimeout(timeoutId);
        reject(new Error("Signing cancelled."));
      });
    });
    txPromise.then(
      (h) => settle(() => {
        window.clearTimeout(timeoutId);
        resolve(h);
      }),
      (e: unknown) => settle(() => {
        window.clearTimeout(timeoutId);
        reject(e instanceof Error ? e : new Error(String(e)));
      }),
    );
  });
}

function withHex(s: string): string {
  return s.startsWith("0x") || s.startsWith("0X") ? s : `0x${s}`;
}

function shortTx(h: string): string {
  return `${h.slice(0, 10)}…`;
}
