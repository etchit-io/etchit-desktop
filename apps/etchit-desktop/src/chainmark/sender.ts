// Chainmark v1 sender. Builds a single-entry chainmark batch, seals
// it under the user's chainmark key, derives the per-tx recipient,
// and broadcasts as a 0-value Arbitrum One transaction through the
// WalletConnect provider. Fire-and-forget from the caller's
// perspective — failures don't reverse the etch that already
// succeeded.
//
// V1 is WalletConnect-only: chainmark sync is for "same wallet
// across devices", which is mostly mobile + extension wallet
// territory. The internal-mode paste-key flow is a single-device hot
// upload wallet by design (see settings → Advanced copy), and
// broadcasting raw 0-value txs from Rust is V1.1.

import type { Eip1193Provider } from "ethers";

import { recipientForBlob, seal } from "./crypto";
import { getOrDeriveKey } from "./key";
import { encode, type WireAction, type WireEntry } from "./payload";
import { CHAINMARK_CHAIN_ID } from "./spec";

export interface SendChainmarkResult {
  /** 0x-prefixed Arbitrum tx hash. */
  txHash: string;
  /** Per-tx derived recipient — useful for diagnostics. */
  recipient: string;
}

/** Push a single chainmark entry. Caller is responsible for ensuring
 *  the wallet is connected and on Arbitrum One; we pass `chainId`
 *  through to `eth_sendTransaction` so a mismatched session fails
 *  before broadcast rather than landing on the wrong chain. */
export async function pushChainmark(
  walletAddress: string,
  provider: Eip1193Provider,
  entry: {
    addr: string;
    title: string;
    action: WireAction;
  },
): Promise<SendChainmarkResult> {
  const key = await getOrDeriveKey(walletAddress, provider);

  const wire: WireEntry = {
    kind: "public",
    addr: entry.addr,
    title: entry.title,
    ts: Math.floor(Date.now() / 1000),
    action: entry.action,
  };
  const payloadBytes = new TextEncoder().encode(encode([wire]));
  const blob = await seal(key, payloadBytes);
  if (!blob) throw new Error("chainmark payload exceeds the 16 KiB bucket");
  const recipient = await recipientForBlob(blob);
  const calldata = "0x" + hex(blob);

  const txHash = (await provider.request({
    method: "eth_sendTransaction",
    params: [
      {
        from: walletAddress,
        to: recipient,
        value: "0x0",
        data: calldata,
        chainId: `0x${CHAINMARK_CHAIN_ID.toString(16)}`,
      },
    ],
  })) as string;

  return { txHash, recipient };
}

function hex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}
