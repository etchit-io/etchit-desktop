// etchit desktop frontend.
//
// Chain/it (chainmarks) viewer ported from tools/chainmarks.html in etchit-android-v3.
// Phase 2 wires the Tauri Rust backend (ant-ffi) so content can be
// fetched in-app instead of shelling out to ant-cli.

import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { createAppKit } from "@reown/appkit";
import { EthersAdapter } from "@reown/appkit-adapter-ethers";
import { arbitrum } from "@reown/appkit/networks";
import { Interface, JsonRpcProvider, type Eip1193Provider } from "ethers";
import { BIP39_WORDLIST } from "./wordlist-bip39";

// EVM constants — match BuildConfig in etchit-android-v3/app/build.gradle.kts.
const ARBITRUM_RPC = "https://arb1.arbitrum.io/rpc";
const ANT_TOKEN_ADDRESS = "0xa78d8321B20c4Ef90eCd72f2588AA985A4BDb684";
const VAULT_ADDRESS = "0x9A3EcAc693b699Fc0B2B6A50B5549e50c2320A26";
const ARBITRUM_CHAIN_ID = 42161;
const SESSION_BUDGET_ATTO = 20_000_000_000_000_000_000n; // 20 ANT

const ERC20_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
];
const VAULT_ABI = [
  "function payForQuotes(tuple(address rewardsAddress, uint256 amount, bytes32 quoteHash)[] payments)",
];
const erc20Iface = new Interface(ERC20_ABI);
const vaultIface = new Interface(VAULT_ABI);

const rpc = new JsonRpcProvider(ARBITRUM_RPC, ARBITRUM_CHAIN_ID, { staticNetwork: true });

// Tauri v2 with withGlobalTauri=true exposes window.__TAURI__. Either of
// __TAURI_INTERNALS__ or __TAURI__ being present means we're inside the
// desktop webview vs. running in a plain browser dev session.
const inTauri =
  typeof (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== "undefined" ||
  typeof (window as unknown as { __TAURI__?: unknown }).__TAURI__ !== "undefined";

// Reown AppKit (WalletConnect v2). Project ID matches the mobile app's
// REOWN_PROJECT_ID; not secret — embedded in the JS bundle and visible
// in the APK's BuildConfig regardless. Tauri webviews don't ship with
// extension wallets, so the QR-pairing path with mobile wallets is the
// expected flow on desktop.
const REOWN_PROJECT_ID = "aebccdd6a244efb2ca596326f00b90d2";

const appKit = createAppKit({
  adapters: [new EthersAdapter()],
  networks: [arbitrum],
  projectId: REOWN_PROJECT_ID,
  metadata: {
    name: "etchit",
    description: "Decentralized pastebin on Autonomi",
    url: "https://etchit.io",
    icons: ["https://etchit.io/icon.svg"],
  },
  // Surface ANT balance inside the AppKit Manage modal alongside ETH.
  tokens: {
    "eip155:42161": { address: "0xa78d8321B20c4Ef90eCd72f2588AA985A4BDb684" },
  },
  features: { analytics: false, email: false, socials: false },
});

const VERSION_BYTE = 0x01;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const BUCKETS = [1024, 4096, 16384] as const;
const RECIPIENT_PREFIX = new TextEncoder().encode("etchit-chainmark-v1/recipient");

// =================================================================
//  FROZEN — chainmark v1 protocol message (cross-client contract)
// =================================================================
// Locked in docs/chainmark-format-v1.md (§4.1). Mobile (Kotlin),
// web viewer (JS), Python CLI, and this client must all sign the
// SAME bytes — otherwise the derived key differs and cross-device
// chainmark sync breaks.
//
// 131 bytes UTF-8.
// SHA-256: ab6f4ae288e6053c3e2181c83e33065c870a8b58b76b1d6b0072aba658cecab0
// =================================================================
const SIGN_MESSAGE =
  "etchit chainmark v1\n\n" +
  "Sign this message to derive your chainmark key. " +
  "This signature does NOT authorize any transaction or transfer.";

// =================================================================
//  FROZEN — DO NOT EDIT THE BYTES OF THIS MESSAGE
// =================================================================
// The wallet signature over these exact bytes is the IKM for HKDF.
// Any edit (whitespace, punctuation, case, anything) changes the
// signature, changes the derived key, and silently makes every
// existing user's private etches undecryptable. There is no
// recovery — the data-maps are gone.
//
// To change the wording: bump the version (`v2`) AND introduce a
// migration path that decrypts old entries with the v1 key and
// re-encrypts with the v2 key, OR keeps both keys cached.
//
// 188 bytes UTF-8.
// SHA-256: 761f194f8756aba672cd7c502a5a3aaf2d4908c5cf9420a702090d4992febc7d
// =================================================================
const SIGN_MESSAGE_PRIVATE =
  "etchit private storage v1\n\n" +
  "Sign this message to derive the key that encrypts and decrypts " +
  "your private etches on this device. This signature does NOT " +
  "authorize any transaction or transfer.";

// FROZEN — Spec §4.3 (cross-client). Mobile, web viewer, and Python
// CLI hash the same string. Any edit silently breaks chainmark sync.
const HKDF_INFO = new TextEncoder().encode("etchit-chainmark/v1/aead-key");

// Defence-in-depth: hash the frozen sign messages at startup and abort
// loudly if either has drifted. A silent edit to either string would
// silently change the derived keys and corrupt user data; this turns
// that into a hard failure instead.
const SIGN_MESSAGE_SHA256 = "ab6f4ae288e6053c3e2181c83e33065c870a8b58b76b1d6b0072aba658cecab0";
const SIGN_MESSAGE_PRIVATE_SHA256 = "761f194f8756aba672cd7c502a5a3aaf2d4908c5cf9420a702090d4992febc7d";

async function sha256Hex(s: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return Array.from(digest).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function assertSignMessagesPinned(): Promise<void> {
  const lib = await sha256Hex(SIGN_MESSAGE);
  if (lib !== SIGN_MESSAGE_SHA256) {
    throw new Error(
      `SIGN_MESSAGE bytes drifted from spec (got ${lib}, expected ${SIGN_MESSAGE_SHA256}). ` +
      `Chainmark cross-device sync is broken. Revert the message or bump the protocol version.`,
    );
  }
  const priv = await sha256Hex(SIGN_MESSAGE_PRIVATE);
  if (priv !== SIGN_MESSAGE_PRIVATE_SHA256) {
    throw new Error(
      `SIGN_MESSAGE_PRIVATE bytes drifted from spec (got ${priv}, expected ${SIGN_MESSAGE_PRIVATE_SHA256}). ` +
      `Existing private etches are now undecryptable. Revert the message or bump to v2 with a migration path.`,
    );
  }
}

void assertSignMessagesPinned();
// FROZEN — desktop-local. Distinct from HKDF_INFO so backing up the
// chainmark key doesn't leak data-maps and vice-versa. Any edit silently
// makes existing private etches undecryptable. Bump v1 -> v2 + add a
// migration if you need to change.
const HKDF_INFO_PRIVATE_STORAGE = new TextEncoder().encode("etchit-private-storage/v1/data-map-key");

type ChainmarkEntry = {
  addr: string;
  title: string;
  ts: number;
  bookmark: boolean;
  hidden: boolean;
};

type WireEntry = {
  kind?: unknown;
  addr?: unknown;
  title?: unknown;
  ts?: unknown;
  action?: unknown;
};

type IndexerTx = {
  from?: string;
  to?: string;
  value?: string;
  input?: string;
  blockNumber?: string;
  transactionIndex?: string;
};

export {};

// ── helpers ──────────────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  if (clean.length % 2 !== 0) throw new Error("hex length must be even");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

function concat(...arrs: Uint8Array[]): Uint8Array {
  const len = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}

// ── recipient verification (§3.1) ────────────────────────────────

async function recipientForBlob(blob: Uint8Array): Promise<string> {
  const nonce = blob.slice(2, 2 + NONCE_LEN);
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", concat(RECIPIENT_PREFIX, nonce)),
  );
  return "0x" + bytesToHex(digest.slice(12, 32));
}

// ── AEAD open (§5, §7, §8) ───────────────────────────────────────

async function openBlob(keyMaterial: Uint8Array, blob: Uint8Array): Promise<Uint8Array | null> {
  if (blob.length < 2 + NONCE_LEN + TAG_LEN) return null;
  if (blob[0] !== VERSION_BYTE) return null;
  const bucketId = blob[1];
  if (bucketId < 0 || bucketId >= BUCKETS.length) return null;
  const bucketSize = BUCKETS[bucketId];
  if (blob.length !== 2 + NONCE_LEN + bucketSize + TAG_LEN) return null;

  const nonce = blob.slice(2, 2 + NONCE_LEN);
  const ct = blob.slice(2 + NONCE_LEN);

  let frame: Uint8Array;
  try {
    const key = await crypto.subtle.importKey("raw", keyMaterial, { name: "AES-GCM" }, false, ["decrypt"]);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ct);
    frame = new Uint8Array(pt);
  } catch {
    return null;
  }
  if (frame.length !== bucketSize) return null;

  const view = new DataView(frame.buffer, frame.byteOffset, 4);
  const payloadLen = view.getUint32(0, true);
  if (4 + payloadLen > bucketSize) return null;
  return frame.slice(4, 4 + payloadLen);
}

// ── replay (§11) ─────────────────────────────────────────────────

function applyEntries(state: Map<string, ChainmarkEntry>, entries: WireEntry[]): void {
  for (const e of entries) {
    if (e.kind !== "public") continue;
    const addr = typeof e.addr === "string" ? e.addr : "";
    if (!/^[0-9a-f]{64}$/.test(addr)) continue;
    const action = e.action;
    const title = typeof e.title === "string" ? e.title : "";
    const ts = typeof e.ts === "number" ? e.ts : 0;
    if (action === "add" || action === "bookmark") {
      state.set(addr, { addr, title, ts, bookmark: action === "bookmark", hidden: false });
    } else if (action === "hide") {
      const existing = state.get(addr);
      if (existing) state.set(addr, { ...existing, hidden: true });
      else state.set(addr, { addr, title: "", ts: 0, bookmark: false, hidden: true });
    }
  }
}

// ── BlockScout fetch + filter ────────────────────────────────────

async function fetchAndDecode(walletAddr: string, keyMaterial: Uint8Array, indexerBase: string): Promise<ChainmarkEntry[]> {
  const url = `${indexerBase}?module=account&action=txlist&address=${encodeURIComponent(walletAddr)}&sort=asc`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`indexer HTTP ${r.status}`);
  const body = await r.json() as { result?: IndexerTx[] };
  const txs = body.result || [];
  const fromFilter = walletAddr.toLowerCase();

  const decoded: { blockNum: number; txIndex: number; entries: WireEntry[] }[] = [];
  for (const tx of txs) {
    if ((tx.from || "").toLowerCase() !== fromFilter) continue;
    if (tx.value !== "0") continue;
    const input = tx.input || "";
    if (!input || input === "0x") continue;
    let blob: Uint8Array;
    try { blob = hexToBytes(input); } catch { continue; }
    if (blob.length < 14 || blob[0] !== VERSION_BYTE) continue;
    const expectedTo = await recipientForBlob(blob);
    if ((tx.to || "").toLowerCase() !== expectedTo.toLowerCase()) continue;
    const plaintext = await openBlob(keyMaterial, blob);
    if (!plaintext) continue;
    let payload: { v?: number; entries?: unknown };
    try { payload = JSON.parse(new TextDecoder().decode(plaintext)); } catch { continue; }
    if (payload.v !== 1 || !Array.isArray(payload.entries)) continue;
    decoded.push({
      blockNum: parseInt(tx.blockNumber || "0", 10),
      txIndex: parseInt(tx.transactionIndex || "0", 10),
      entries: payload.entries as WireEntry[],
    });
  }
  decoded.sort((a, b) => a.blockNum - b.blockNum || a.txIndex - b.txIndex);

  const state = new Map<string, ChainmarkEntry>();
  for (const d of decoded) applyEntries(state, d.entries);
  return Array.from(state.values());
}

// ── HKDF (§4.3) — derive 32-byte AES key from a wallet signature ─

async function deriveKeyFromSig(signatureHex: string, info: Uint8Array): Promise<Uint8Array> {
  // signatureHex is 0x-prefixed (r||s||v), 65 bytes total. Spec uses (r||s) as IKM.
  const sigBytes = hexToBytes(signatureHex);
  if (sigBytes.length !== 65) throw new Error(`unexpected sig length ${sigBytes.length}`);
  const ikm = sigBytes.slice(0, 64);
  const ikmKey = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info },
    ikmKey,
    256,
  );
  return new Uint8Array(bits);
}

// ── Wallet flow (Reown AppKit) ───────────────────────────────────

type AppKitAccount = { isConnected?: boolean; address?: string };

async function waitForAppKitConnection(): Promise<string> {
  const current = appKit.getAccount() as AppKitAccount | undefined;
  if (current?.isConnected && current.address) return current.address;

  // Open modal AND subscribe in parallel — modal stays open until user
  // either pairs or closes it; subscribe fires on pairing success.
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const unsub = appKit.subscribeAccount((a: AppKitAccount) => {
      if (settled) return;
      if (a.isConnected && a.address) {
        settled = true;
        unsub();
        resolve(a.address);
      }
    });
    appKit.open().catch((e: unknown) => {
      if (settled) return;
      settled = true;
      unsub();
      reject(e);
    });
  });
}

// Cached wallet-derived keys. Chainmark and private-storage are derived
// from independent personal_sign calls (different messages) so a user
// who signs one isn't unknowingly authorizing the other.
let walletKeys: { wallet: string; chainmarkKey?: Uint8Array; storageKey?: Uint8Array } | null = null;

async function ensureWalletConnected(): Promise<{ wallet: string; provider: Eip1193Provider }> {
  const wallet = await waitForAppKitConnection();
  const provider = appKit.getWalletProvider() as Eip1193Provider | undefined;
  if (!provider) throw new Error("Wallet connected but no provider available.");
  if (!walletKeys || walletKeys.wallet.toLowerCase() !== wallet.toLowerCase()) {
    walletKeys = { wallet };
  }
  return { wallet, provider };
}

async function signAndDerive(message: string, info: Uint8Array, label: string): Promise<Uint8Array> {
  const { wallet, provider } = await ensureWalletConnected();
  // AppKit routes provider.request() to its configured network (eip155:42161).
  // If the wallet's active session is on a different chain, AppKit rejects the
  // request with "Missing or invalid. request() chainId: eip155:42161" before
  // it ever reaches the wallet. Switch the chain first to bring the session
  // namespace in line — same pattern as sendTx().
  await ensureArbitrumChain(provider);
  const messageHex = "0x" + bytesToHex(new TextEncoder().encode(message));
  // Raw EIP-1193 personal_sign — ethers BrowserProvider multiplexes extra
  // chain/accounts queries that have triggered "Invalid Id" on MetaMask
  // Mobile through WalletConnect.
  const sigHex = await withWalletPrompt(label, async () =>
    (await provider.request({
      method: "personal_sign",
      params: [messageHex, wallet],
    })) as string,
  );
  return await deriveKeyFromSig(sigHex, info);
}

async function ensureChainmarkKey(): Promise<{ wallet: string; key: Uint8Array }> {
  if (walletKeys?.chainmarkKey) return { wallet: walletKeys.wallet, key: walletKeys.chainmarkKey };
  const key = await signAndDerive(SIGN_MESSAGE, HKDF_INFO, "sign the chainmark-derive message in your wallet");
  walletKeys = { ...(walletKeys ?? { wallet: (await ensureWalletConnected()).wallet }), chainmarkKey: key };
  return { wallet: walletKeys.wallet, key };
}

async function ensureStorageKey(): Promise<{ wallet: string; key: Uint8Array }> {
  if (walletKeys?.storageKey) return { wallet: walletKeys.wallet, key: walletKeys.storageKey };
  const key = await signAndDerive(SIGN_MESSAGE_PRIVATE, HKDF_INFO_PRIVATE_STORAGE, "sign the private-storage message in your wallet");
  walletKeys = { ...(walletKeys ?? { wallet: (await ensureWalletConnected()).wallet }), storageKey: key };
  return { wallet: walletKeys.wallet, key };
}

// Backwards-compatible name kept for the existing Connect-wallet handler.
async function connectAndDeriveKey(): Promise<{ wallet: string; key: Uint8Array }> {
  return await ensureChainmarkKey();
}

// ── Chainmark write (Phase 3b) ─────────────────────────────────────
//
// Mirrors ChainmarkCrypto.seal + ChainmarkSync.sendBatch on Android. Encodes
// a one-entry payload, AES-GCM-seals it with bucket padding, computes the
// per-tx recipient, and sends a 0-value Arbitrum tx via the wallet.

async function sealChainmarkBatch(key: Uint8Array, payload: Uint8Array): Promise<Uint8Array | null> {
  let bucketId = -1;
  let bucketSize = 0;
  for (let i = 0; i < BUCKETS.length; i++) {
    if (4 + payload.length <= BUCKETS[i]) { bucketId = i; bucketSize = BUCKETS[i]; break; }
  }
  if (bucketId < 0) return null;

  const frame = new Uint8Array(bucketSize);
  new DataView(frame.buffer).setUint32(0, payload.length, true);
  frame.set(payload, 4);

  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LEN));
  const aesKey = await crypto.subtle.importKey("raw", key, { name: "AES-GCM" }, false, ["encrypt"]);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, frame),
  );

  const blob = new Uint8Array(2 + NONCE_LEN + ct.length);
  blob[0] = VERSION_BYTE;
  blob[1] = bucketId;
  blob.set(nonce, 2);
  blob.set(ct, 2 + NONCE_LEN);
  return blob;
}

type ChainmarkAction = "add" | "bookmark" | "hide";

async function addToChainmarks(addr: string, title: string, action: ChainmarkAction = "add"): Promise<string> {
  const { wallet, key } = await ensureChainmarkKey();
  const walletProvider = appKit.getWalletProvider() as Eip1193Provider | undefined;
  if (!walletProvider) throw new Error("Wallet provider unavailable.");

  const wireEntry = {
    kind: "public",
    addr: addr.toLowerCase(),
    title,
    ts: Math.floor(Date.now() / 1000),
    action,
  };
  const payloadJson = JSON.stringify({ v: 1, entries: [wireEntry] });
  const payload = new TextEncoder().encode(payloadJson);
  const blob = await sealChainmarkBatch(key, payload);
  if (!blob) throw new Error("Chainmark entry too large for max bucket.");

  const recipient = await recipientForBlob(blob);
  const calldata = "0x" + bytesToHex(blob);
  await ensureArbitrumChain(walletProvider);
  return await withWalletPrompt("sign the chainmark update in your wallet", async () =>
    (await walletProvider.request({
      method: "eth_sendTransaction",
      params: [{ from: wallet, to: recipient, data: calldata, value: "0x0" }],
    })) as string,
  );
}

// ── UI ───────────────────────────────────────────────────────────

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

function setStatus(id: string, msg: string, cls: string = ""): void {
  const el = $(id);
  el.textContent = msg;
  el.className = "status " + cls;
}

// 6-word passphrase entry: 1 row of 6 boxes with em-dash separators, plus a
// "Use a custom password instead" toggle for users who used a non-diceware password.
// Returns getValue() (joins with '-' to match the generator's output format) and clear().
function buildPassphraseEntry(parent: HTMLElement): { getValue: () => string; clear: () => void } {
  const wrap = document.createElement("div");
  wrap.className = "passphrase-entry";
  parent.appendChild(wrap);

  const row = document.createElement("div");
  row.className = "passphrase-row";
  wrap.appendChild(row);

  const boxes: HTMLInputElement[] = [];
  for (let i = 0; i < 6; i++) {
    if (i > 0) {
      const sep = document.createElement("span");
      sep.className = "passphrase-sep";
      sep.textContent = "—";
      row.appendChild(sep);
    }
    const box = document.createElement("input");
    box.type = "text";
    box.className = "passphrase-box";
    box.placeholder = String(i + 1);
    box.autocomplete = "off";
    box.spellcheck = false;
    box.setAttribute("autocapitalize", "off");
    box.setAttribute("autocorrect", "off");
    row.appendChild(box);
    boxes.push(box);
  }

  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i];
    box.addEventListener("input", () => {
      const v = box.value;
      if (/[\s\-—]/.test(v)) {
        const parts = v.split(/[\s\-—]+/).filter((p) => p.length > 0);
        if (parts.length >= 2) {
          for (let j = 0; j < parts.length && i + j < boxes.length; j++) {
            boxes[i + j].value = parts[j].toLowerCase();
          }
          const next = Math.min(i + parts.length, boxes.length - 1);
          boxes[next].focus();
        } else {
          box.value = (parts[0] ?? "").toLowerCase();
          if (i < boxes.length - 1) boxes[i + 1].focus();
        }
      }
    });
    box.addEventListener("keydown", (e) => {
      if (e.key === "Backspace" && box.value.length === 0 && i > 0) {
        e.preventDefault();
        const prev = boxes[i - 1];
        prev.focus();
        prev.setSelectionRange(prev.value.length, prev.value.length);
      } else if (e.key === "Enter" && i < boxes.length - 1) {
        e.preventDefault();
        boxes[i + 1].focus();
      }
    });
  }

  const customInput = document.createElement("input");
  customInput.type = "password";
  customInput.placeholder = "Custom password";
  customInput.autocomplete = "off";
  customInput.style.display = "none";
  customInput.style.marginBottom = "12px";
  wrap.appendChild(customInput);

  let customMode = false;
  const link = document.createElement("a");
  link.className = "passphrase-toggle";
  link.textContent = "Use a custom password instead";
  link.href = "#";
  link.onclick = (e) => {
    e.preventDefault();
    customMode = !customMode;
    if (customMode) {
      row.style.display = "none";
      customInput.style.display = "block";
      customInput.focus();
      link.textContent = "Use the 6-word passphrase instead";
    } else {
      row.style.display = "";
      customInput.style.display = "none";
      boxes[0].focus();
      link.textContent = "Use a custom password instead";
    }
  };
  wrap.appendChild(link);

  return {
    getValue: () => {
      if (customMode) return customInput.value;
      return boxes.map((b) => b.value.trim().toLowerCase()).join("-");
    },
    clear: () => {
      for (const b of boxes) b.value = "";
      customInput.value = "";
    },
  };
}

function render(entries: ChainmarkEntry[]): void {
  const root = $("results");
  root.innerHTML = "";
  const visible = entries.filter((e) => !e.hidden).sort((a, b) => b.ts - a.ts);
  if (!visible.length) {
    const div = document.createElement("div");
    div.className = "empty";
    div.textContent = "No chainmarks yet (or all entries are hidden).";
    root.appendChild(div);
    return;
  }
  for (const e of visible) {
    const row = document.createElement("div");
    row.className = "row";

    const title = document.createElement("div");
    title.className = "title";
    title.textContent = e.title || "Untitled";
    row.appendChild(title);

    const addr = document.createElement("div");
    addr.className = "addr";
    addr.textContent = e.addr;
    row.appendChild(addr);

    const actions = document.createElement("div");
    actions.className = "actions";

    const copyAddr = document.createElement("button");
    copyAddr.className = "outlined";
    copyAddr.textContent = "Copy address";
    copyAddr.onclick = () => {
      navigator.clipboard.writeText(e.addr);
      setStatus("status", "Address copied", "ok");
    };
    actions.appendChild(copyAddr);

    if (inTauri) {
      const fetchBtn = document.createElement("button");
      fetchBtn.className = "outlined";
      fetchBtn.textContent = "Fetch";
      fetchBtn.onclick = () => {
        fetchBtn.disabled = true;
        fetchBtn.textContent = "Fetching…";
        void fetchInto(row, e.addr, e.title).finally(() => {
          fetchBtn.disabled = false;
          fetchBtn.textContent = "Fetch";
        });
      };
      actions.appendChild(fetchBtn);
    } else {
      const copyCmd = document.createElement("button");
      copyCmd.className = "outlined";
      copyCmd.textContent = "Copy ant command";
      copyCmd.onclick = () => {
        const safe = (e.title || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 50) || e.addr.slice(0, 10);
        navigator.clipboard.writeText(`ant file download --output ${safe} ${e.addr}`);
        setStatus("status", "Command copied", "ok");
      };
      actions.appendChild(copyCmd);
    }

    const hideBtn = document.createElement("button");
    hideBtn.className = "outlined";
    hideBtn.textContent = "Hide";
    hideBtn.onclick = () => {
      // Two-step inline confirm — hide costs gas (Arbitrum tx) and
      // can be reversed only with another tx (re-add).
      const original = actions.cloneNode(true);
      actions.innerHTML = "";

      const warn = document.createElement("div");
      warn.className = "fetch-meta";
      warn.style.color = "var(--copper)";
      warn.style.marginBottom = "6px";
      warn.textContent = "Hide writes a tx to Arbitrum (gas). The entry won't show after the next sync. Reversible by adding it again.";
      actions.appendChild(warn);

      const btnRow = document.createElement("div");
      btnRow.style.display = "flex";
      btnRow.style.gap = "6px";

      const cancel = document.createElement("button");
      cancel.className = "outlined";
      cancel.textContent = "Cancel";
      cancel.onclick = () => actions.replaceWith(original as HTMLElement);
      btnRow.appendChild(cancel);

      const confirm = document.createElement("button");
      confirm.className = "outlined";
      confirm.style.borderColor = "var(--copper)";
      confirm.style.color = "var(--copper)";
      confirm.textContent = "Hide entry";
      confirm.onclick = async () => {
        confirm.disabled = true;
        confirm.textContent = "Signing…";
        try {
          const txHash = await addToChainmarks(e.addr, e.title || "", "hide");
          confirm.textContent = `Waiting (${txHash.slice(0, 10)}…)`;
          await rpc.waitForTransaction(txHash);
          // Optimistic local update — the BlockScout indexer will catch
          // up in 30-60s; meanwhile mark hidden in the in-memory cache
          // so the row disappears immediately.
          currentChainmarks = currentChainmarks.map((x) =>
            x.addr === e.addr ? { ...x, hidden: true } : x,
          );
          render(currentChainmarks);
          setStatus("status", "Entry hidden", "ok");
        } catch (err) {
          actions.replaceWith(original as HTMLElement);
          setStatus("status", `Hide failed: ${(err as Error).message ?? String(err)}`, "err");
        }
      };
      btnRow.appendChild(confirm);

      actions.appendChild(btnRow);
    };
    actions.appendChild(hideBtn);

    row.appendChild(actions);
    root.appendChild(row);
  }
}

// Cache of decoded chainmark entries — kept in module scope so optimistic
// add / hide can mutate the rendered list without re-running the full
// BlockScout decode (which won't see new txs until the indexer catches
// up, ~30-60s).
let currentChainmarks: ChainmarkEntry[] = [];

async function runDecode(wallet: string, keyBytes: Uint8Array): Promise<void> {
  const indexer = readSavedIndexer() ?? $<HTMLInputElement>("indexer").value.trim();
  setStatus("status", "Fetching from indexer…");
  $("results").innerHTML = "";
  const entries = await fetchAndDecode(wallet, keyBytes, indexer);
  currentChainmarks = entries;
  render(entries);
  const visible = entries.filter((e) => !e.hidden).length;
  setStatus("status", `Decoded ${entries.length} entries (${visible} visible).`, "ok");
}

$("addByAddrBtn").addEventListener("click", async () => {
  const rawAddr = $<HTMLInputElement>("addAddr").value.trim().toLowerCase().replace(/^0x/, "");
  const title = $<HTMLInputElement>("addTitle").value.trim();
  const setAddStatus = (msg: string, cls: "ok" | "err" | "warn" | "" = "") => {
    const el = $("addByAddrStatus");
    el.textContent = msg;
    el.className = "status" + (cls ? ` ${cls}` : "");
  };
  if (!/^[0-9a-f]{64}$/.test(rawAddr)) {
    setAddStatus("Invalid address (need 64 hex chars).", "err");
    return;
  }
  const btn = $<HTMLButtonElement>("addByAddrBtn");
  btn.disabled = true;
  setAddStatus("Sending tx…", "warn");
  try {
    const txHash = await addToChainmarks(rawAddr, title, "add");
    setAddStatus(`Waiting (${txHash.slice(0, 10)}…)`, "warn");
    const receipt = await rpc.waitForTransaction(txHash);
    if (!receipt) {
      setAddStatus(`Tx ${txHash.slice(0, 10)}… didn't confirm — try again`, "err");
      return;
    }
    if (receipt.status !== 1) {
      setAddStatus(`Tx reverted (${txHash})`, "err");
      return;
    }
    // Tx confirmed on chain — safe to optimistically merge until next decode.
    const newEntry: ChainmarkEntry = {
      addr: rawAddr,
      title,
      ts: Math.floor(Date.now() / 1000),
      bookmark: false,
      hidden: false,
    };
    currentChainmarks = currentChainmarks
      .filter((e) => e.addr !== rawAddr)
      .concat(newEntry);
    render(currentChainmarks);
    setAddStatus("Added.", "ok");
    $<HTMLInputElement>("addAddr").value = "";
    $<HTMLInputElement>("addTitle").value = "";
  } catch (e) {
    setAddStatus(`Failed: ${(e as Error).message ?? String(e)}`, "err");
  } finally {
    btn.disabled = false;
  }
});

$("toggleKey").addEventListener("click", () => {
  const inp = $<HTMLInputElement>("key");
  const btn = $("toggleKey");
  if (inp.type === "password") { inp.type = "text"; btn.textContent = "Hide"; }
  else { inp.type = "password"; btn.textContent = "Show"; }
});

$("connect").addEventListener("click", async () => {
  setStatus("connectStatus", "");
  setStatus("status", "");
  // Require wallet to be connected first via the wallet bar — keeps
  // wallet-connect and chainmark-derive as two distinct user actions
  // instead of bundling them into one prompt sequence.
  if (!knownWallet()) {
    setStatus("connectStatus", "Connect a wallet first.", "err");
    return;
  }
  const btn = $<HTMLButtonElement>("connect");
  btn.disabled = true;
  try {
    setStatus("connectStatus", "Requesting chainmark-derive signature…");
    const { wallet, key } = await ensureChainmarkKey();
    setStatus("connectStatus", `Connected ${wallet.slice(0, 6)}…${wallet.slice(-4)}`, "ok");
    await runDecode(wallet, key);
  } catch (e) {
    const msg = (e as Error)?.message || String(e) || "(no error message)";
    console.error("Sync chainmarks failed:", e);
    setStatus("connectStatus", `Failed: ${msg}`, "err");
  } finally {
    btn.disabled = false;
  }
});

// Clear all transient UI state — typed text, status messages, error
// banners, in-line fetch result panels. Doesn't touch wallet, chainmarks,
// private etches, history, or in-flight etches.
$("resetView").addEventListener("click", () => {
  $<HTMLInputElement>("etchTitle").value = "";
  $<HTMLTextAreaElement>("etchText").value = "";
  $<HTMLInputElement>("etchPrivate").checked = false;
  setEtchStatus("");
  $("etchResult").innerHTML = "";

  setStatus("connectStatus", "");
  setStatus("status", "");
  setStatus("addByAddrStatus", "");

  document.querySelectorAll(".fetch-result").forEach((el) => el.remove());
});

$("decodeManual").addEventListener("click", async () => {
  setStatus("status", "");
  $("results").innerHTML = "";
  const wallet = $<HTMLInputElement>("wallet").value.trim();
  const keyHex = $<HTMLInputElement>("key").value.trim().replace(/^0x/, "");

  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
    return setStatus("status", "Invalid wallet address (need 0x + 40 hex chars).", "err");
  }
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    return setStatus("status", `Invalid chainmark key (need 64 hex chars, got ${keyHex.length}).`, "err");
  }

  const btn = $<HTMLButtonElement>("decodeManual");
  btn.disabled = true;
  try {
    await runDecode(wallet, hexToBytes(keyHex));
  } catch (e) {
    setStatus("status", `Failed: ${(e as Error).message}`, "err");
  } finally {
    btn.disabled = false;
  }
});

// AppKit is wired so the Connect button always works — the modal opens
// a WalletConnect QR for mobile-wallet pairing, which is the desktop
// path. Manual key entry stays available below as a fallback.

// ── Autonomi network bridge (Phase 2a) ───────────────────────────

function setNetStatus(msg: string, cls: "ok" | "err" | "warn" | "" = ""): void {
  const bar = $("network");
  $("netStatus").textContent = msg;
  bar.className = "net-bar" + (cls ? ` ${cls}` : "");
}

// Warmup constants — same as Android MainActivity.kt. Client::connect
// returns as soon as one peer attaches; DHT bootstrap continues in the
// background, so peer count rises over the next several seconds.
const WARMUP_TARGET_PEERS = 10;
const WARMUP_SUSTAINED_MS = 3_000;
const WARMUP_CAP_MS = 15_000;
const PEER_REFRESH_MS = 5_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Same default peer list mirrored from Rust DEFAULT_PEERS (kept in sync
// for the Settings textarea hint). User saves a comma/newline-separated
// list; we pass it through to the FFI as multiaddrs.
const DEFAULT_BOOTSTRAP_TEXT = [
  "207.148.94.42:10000",
  "45.77.50.10:10000",
  "66.135.23.83:10000",
  "149.248.9.2:10000",
  "49.12.119.240:10000",
  "5.161.25.133:10000",
  "18.228.202.183:10000",
].join("\n");

function normalizeMultiaddr(addr: string): string {
  if (addr.startsWith("/")) return addr;
  const parts = addr.split(":");
  if (parts.length === 2) return `/ip4/${parts[0]}/udp/${parts[1]}/quic`;
  return addr;
}

function readSavedPeers(): string[] | null {
  const raw = localStorage.getItem("etchit:bootstrap-peers:v1");
  if (!raw || !raw.trim()) return null;
  const lines = raw.split("\n").map((s) => s.trim()).filter(Boolean).map(normalizeMultiaddr);
  return lines.length ? lines : null;
}

function readSavedIndexer(): string | null {
  const v = localStorage.getItem("etchit:indexer-url:v1");
  return v && v.trim() ? v.trim() : null;
}

async function autoConnect(): Promise<void> {
  if (!inTauri) {
    setNetStatus("not running inside Tauri (no FFI)", "warn");
    return;
  }
  setNetStatus("connecting…", "warn");
  try {
    const saved = readSavedPeers();
    await invoke<number>("connect", saved ? { peers: saved } : {});
  } catch (e) {
    setNetStatus(`failed: ${(e as Error).message ?? String(e)}`, "err");
    return;
  }

  // Warmup: poll until peer count is ≥ target sustained for SUSTAINED_MS,
  // capped at CAP_MS total.
  const warmupStart = Date.now();
  let sustainedSince = -1;
  let lastCount = 0;
  while (Date.now() - warmupStart < WARMUP_CAP_MS) {
    try { lastCount = await invoke<number>("peer_count"); } catch { lastCount = 0; }
    setNetStatus(`joining… ${lastCount} peers`, "warn");
    if (lastCount >= WARMUP_TARGET_PEERS) {
      if (sustainedSince < 0) sustainedSince = Date.now();
      if (Date.now() - sustainedSince >= WARMUP_SUSTAINED_MS) break;
    } else {
      sustainedSince = -1;
    }
    await sleep(500);
  }
  setNetStatus(`${lastCount} peers`, "ok");

  // Live refresh forever (cheap; just a peer_count call every few seconds).
  void refreshPeersForever();
}

async function refreshPeersForever(): Promise<void> {
  while (true) {
    await sleep(PEER_REFRESH_MS);
    try {
      const n = await invoke<number>("peer_count");
      setNetStatus(`${n} peers`, "ok");
    } catch {
      setNetStatus("disconnected", "err");
      return;
    }
  }
}

void autoConnect();

// ── Content detection (Phase 2b) ─────────────────────────────────
//
// Mirrors ContentDetector.kt + PasteUtils.parseEnvelope on Android.
// Decides how to render a fetched blob: ETCH_ENVELOPE / TEXT / IMAGE
// / BACKUP / BINARY.

type ContentType = "envelope" | "text" | "image" | "backup" | "binary";
type DetectResult = { type: ContentType; mime: string; ext: string };

const BACKUP_MAGIC = new TextEncoder().encode("ETCHIT_BACKUP_v1\n");

function startsWith(buf: Uint8Array, needle: Uint8Array, offset = 0): boolean {
  if (offset + needle.length > buf.length) return false;
  for (let i = 0; i < needle.length; i++) if (buf[offset + i] !== needle[i]) return false;
  return true;
}

function startsWithStr(buf: Uint8Array, s: string, offset = 0): boolean {
  return startsWith(buf, new TextEncoder().encode(s), offset);
}

function detectContent(data: Uint8Array): DetectResult {
  if (data.length >= BACKUP_MAGIC.length && startsWith(data, BACKUP_MAGIC)) {
    return { type: "backup", mime: "application/octet-stream", ext: "bin" };
  }

  if (data.length <= 10_000_000) {
    try {
      const s = new TextDecoder("utf-8", { fatal: true }).decode(data);
      if (s.includes('"content"') && s.includes('"meta"')) {
        return { type: "envelope", mime: "application/json", ext: "json" };
      }
    } catch { /* not utf-8, fall through */ }
  }

  if (data.length >= 4) {
    if (data[0] === 0x89 && startsWithStr(data, "PNG", 1)) return { type: "image", mime: "image/png", ext: "png" };
    if (data[0] === 0xFF && data[1] === 0xD8 && data[2] === 0xFF) return { type: "image", mime: "image/jpeg", ext: "jpg" };
    if (startsWithStr(data, "GIF8")) return { type: "image", mime: "image/gif", ext: "gif" };
    if (data.length >= 12 && startsWithStr(data, "RIFF") && startsWithStr(data, "WEBP", 8)) return { type: "image", mime: "image/webp", ext: "webp" };
    if (data[0] === 0x42 && data[1] === 0x4D) return { type: "image", mime: "image/bmp", ext: "bmp" };
  }

  // Video / audio / PDF — kept as type:"binary" (no inline preview) but
  // tagged with the right mime + extension so save dialog defaults make
  // sense. Same magic-byte set as ContentDetector.kt.
  if (data.length >= 12 && startsWithStr(data, "ftyp", 4)) return { type: "binary", mime: "video/mp4", ext: "mp4" };
  if (data.length >= 4 && data[0] === 0x1A && data[1] === 0x45 && data[2] === 0xDF && data[3] === 0xA3) return { type: "binary", mime: "video/webm", ext: "webm" };
  if (startsWithStr(data, "ID3") || (data.length >= 2 && data[0] === 0xFF && data[1] === 0xFB)) return { type: "binary", mime: "audio/mpeg", ext: "mp3" };
  if (startsWithStr(data, "OggS")) return { type: "binary", mime: "audio/ogg", ext: "ogg" };
  if (startsWithStr(data, "fLaC")) return { type: "binary", mime: "audio/flac", ext: "flac" };
  if (data.length >= 12 && startsWithStr(data, "RIFF") && startsWithStr(data, "WAVE", 8)) return { type: "binary", mime: "audio/wav", ext: "wav" };
  if (startsWithStr(data, "%PDF")) return { type: "binary", mime: "application/pdf", ext: "pdf" };
  if (data.length >= 4 && data[0] === 0x50 && data[1] === 0x4B && (data[2] === 0x03 || data[2] === 0x05) && (data[3] === 0x04 || data[3] === 0x06)) return { type: "binary", mime: "application/zip", ext: "zip" };

  if (data.length <= 10_000_000) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(data);
      return { type: "text", mime: "text/plain", ext: "txt" };
    } catch { /* not utf-8 */ }
  }

  return { type: "binary", mime: "application/octet-stream", ext: "bin" };
}

function parseEnvelope(raw: string): { title: string; content: string } {
  try {
    const obj = JSON.parse(raw) as { meta?: { title?: unknown }; content?: unknown };
    const title = typeof obj.meta?.title === "string" ? obj.meta.title : "";
    const content = typeof obj.content === "string" ? obj.content : raw;
    return { title, content };
  } catch {
    return { title: "", content: raw };
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Fetch action (Phase 2b) ──────────────────────────────────────

async function fetchInto(row: HTMLDivElement, addr: string, fallbackTitle: string): Promise<void> {
  if (!inTauri) {
    appendError(row, "Fetching requires the desktop app (no FFI in plain browser).");
    return;
  }
  const existing = row.querySelector(".fetch-result");
  if (existing) existing.remove();

  const out = document.createElement("div");
  out.className = "fetch-result loading";
  out.textContent = "Fetching from network…";
  row.appendChild(out);

  let bytes: Uint8Array;
  try {
    // Tauri serializes Rust Vec<u8> as a number[] over JSON IPC. Wasteful
    // for large blobs; fine for the kilobyte-range etches this app handles.
    const arr = await invoke<number[]>("fetch_public", { addrHex: addr });
    bytes = Uint8Array.from(arr);
  } catch (e) {
    out.textContent = "";
    out.classList.remove("loading");
    appendError(out, `Fetch failed: ${(e as Error).message ?? String(e)}`);
    addCloseButton(out);
    return;
  }

  const detected = detectContent(bytes);
  out.innerHTML = "";
  out.classList.remove("loading");
  addCloseButton(out);
  const meta = document.createElement("div");
  meta.className = "fetch-meta";
  meta.textContent = `${detected.type} · ${formatSize(bytes.length)}`;
  out.appendChild(meta);

  switch (detected.type) {
    case "envelope": {
      const text = new TextDecoder().decode(bytes);
      const { title, content } = parseEnvelope(text);
      renderText(out, title || fallbackTitle, content);
      break;
    }
    case "text": {
      const text = new TextDecoder().decode(bytes);
      renderText(out, fallbackTitle, text);
      break;
    }
    case "image": {
      const blob = new Blob([bytes as BlobPart], { type: detected.mime });
      const url = URL.createObjectURL(blob);
      const img = document.createElement("img");
      img.src = url;
      img.className = "fetch-img";
      out.appendChild(img);
      break;
    }
    case "backup": {
      renderBackupDecryptForm(out, bytes);
      break;
    }
    case "binary": {
      const note = document.createElement("div");
      note.className = "fetch-meta";
      note.style.color = "var(--ash)";
      note.textContent = `${detected.mime} — save to disk to open with a native viewer.`;
      out.appendChild(note);
      addSaveButton(out, bytes, fallbackTitle, detected.ext);
      break;
    }
  }
}

function renderBackupDecryptForm(parent: HTMLElement, bytes: Uint8Array): void {
  const note = document.createElement("div");
  note.className = "fetch-meta";
  note.style.color = "var(--ash)";
  note.style.marginBottom = "8px";
  note.textContent = "Encrypted etchit backup. Enter the 6-word recovery passphrase to decrypt and import the private etches into this device.";
  parent.appendChild(note);

  const passphrase = buildPassphraseEntry(parent);

  const status = document.createElement("div");
  status.className = "status";
  status.style.marginBottom = "8px";
  parent.appendChild(status);

  const setLocalStatus = (msg: string, cls: "ok" | "err" | "warn" | "" = "") => {
    status.textContent = msg;
    status.className = "status" + (cls ? ` ${cls}` : "");
  };

  const decryptBtn = document.createElement("button");
  decryptBtn.className = "outlined";
  decryptBtn.textContent = "Decrypt and import";
  decryptBtn.onclick = async () => {
    const pw = passphrase.getValue();
    if (!pw) { setLocalStatus("Passphrase is required.", "err"); return; }
    decryptBtn.disabled = true;
    try {
      setLocalStatus("Decrypting…", "warn");
      const plaintext = await backupDecrypt(bytes, pw);
      if (!plaintext) { setLocalStatus("Decrypt failed — wrong passphrase or corrupted backup.", "err"); decryptBtn.disabled = false; return; }
      setLocalStatus("Importing…", "warn");
      const { imported, skipped } = await importBackupPlaintext(plaintext);
      setLocalStatus(`Restored ${imported} new entr${imported === 1 ? "y" : "ies"}${skipped ? ` (skipped ${skipped} duplicate${skipped === 1 ? "" : "s"})` : ""}.`, "ok");
      passphrase.clear();
    } catch (e) {
      setLocalStatus(`Failed: ${(e as Error).message ?? String(e)}`, "err");
      decryptBtn.disabled = false;
    }
  };
  parent.appendChild(decryptBtn);

  // Also offer raw save in case the user wants to keep the bytes.
  addSaveButton(parent, bytes, "etchit-backup", "etchit-backup");
}

function renderText(parent: HTMLElement, title: string, content: string): void {
  if (title) {
    const t = document.createElement("div");
    t.className = "fetch-title";
    t.textContent = title;
    parent.appendChild(t);
  }
  const pre = document.createElement("pre");
  pre.className = "fetch-text";
  pre.textContent = content;
  parent.appendChild(pre);
}

// ── Private etch storage (Phase 3c) ──────────────────────────────
//
// Tauri webview localStorage is per-app, persisted to disk by WebKit.
// We don't trust the file system for confidentiality; data-maps are
// AES-GCM-sealed with a wallet-derived storage key before write.

type PrivateEntry = { id: string; title: string; ts: number; size: number; cipher: string };

function privateStoreKey(wallet: string): string {
  return `etchit:private-maps:v1:${wallet.toLowerCase()}`;
}

function loadPrivateEntries(wallet: string): PrivateEntry[] {
  try {
    const raw = localStorage.getItem(privateStoreKey(wallet));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { entries?: PrivateEntry[] };
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch { return []; }
}

function savePrivateEntries(wallet: string, entries: PrivateEntry[]): void {
  localStorage.setItem(privateStoreKey(wallet), JSON.stringify({ entries }));
}

async function encryptDataMap(storageKey: Uint8Array, dataMapHex: string): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const aesKey = await crypto.subtle.importKey("raw", storageKey, { name: "AES-GCM" }, false, ["encrypt"]);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, new TextEncoder().encode(dataMapHex)),
  );
  return bytesToHex(nonce) + bytesToHex(ct);
}

async function decryptDataMap(storageKey: Uint8Array, cipherHex: string): Promise<string> {
  const blob = hexToBytes(cipherHex);
  if (blob.length < 12 + 16) throw new Error("private cipher blob too short");
  const nonce = blob.slice(0, 12);
  const ct = blob.slice(12);
  const aesKey = await crypto.subtle.importKey("raw", storageKey, { name: "AES-GCM" }, false, ["decrypt"]);
  try {
    const pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, aesKey, ct));
    return new TextDecoder().decode(pt);
  } catch {
    throw new Error(
      "Could not decrypt data-map — this entry was likely created with a different storage key. " +
      "Delete it (data-map is gone) and re-etch.",
    );
  }
}

// ── Etch history (Phase 3d) ──────────────────────────────────────
//
// Per-wallet local list of etches made on this device. Mirrors
// EtchHistory.kt on Android — public entries get the address, private
// entries get the private-store id so the row can link to the
// data-map. Stored newest-first.

type HistoryEntry = {
  ts: number;
  title: string;
  isPrivate: boolean;
  address?: string;       // public etch
  privateId?: string;     // private etch — points into private store
};

function historyStoreKey(wallet: string): string {
  return `etchit:history:v1:${wallet.toLowerCase()}`;
}

function loadHistory(wallet: string): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(historyStoreKey(wallet));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { entries?: HistoryEntry[] };
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch { return []; }
}

function saveHistory(wallet: string, entries: HistoryEntry[]): void {
  localStorage.setItem(historyStoreKey(wallet), JSON.stringify({ entries }));
}

function pushHistoryPublic(wallet: string, address: string, title: string): void {
  const entries = loadHistory(wallet);
  entries.unshift({ ts: Math.floor(Date.now() / 1000), title, isPrivate: false, address });
  saveHistory(wallet, entries);
  renderHistory();
}

function pushHistoryPrivate(wallet: string, privateId: string, title: string): void {
  const entries = loadHistory(wallet);
  entries.unshift({ ts: Math.floor(Date.now() / 1000), title, isPrivate: true, privateId });
  saveHistory(wallet, entries);
  renderHistory();
}

function newId(): string {
  // Random 8-byte hex id for local-only references; collision-tolerant
  // since it's a per-wallet local index.
  return bytesToHex(crypto.getRandomValues(new Uint8Array(8)));
}

// ── Backup to network (Phase 3f) ─────────────────────────────────
//
// Password-encrypted backup of private etch data-maps, etched publicly
// on Autonomi. Anyone with the resulting address can fetch the bytes;
// only the password decrypts. Same wire format as BackupCrypto.kt so a
// backup created on either client round-trips through the other.
//
// Format:
//   ETCHIT_BACKUP_v1\n   (17 bytes magic)
//   salt                  (16 bytes)
//   iv                    (12 bytes)
//   ciphertext + tag      (remaining)
// Key derivation: PBKDF2-HMAC-SHA256, 600_000 iterations, 256-bit AES-GCM.

const BACKUP_MAGIC_STR = "ETCHIT_BACKUP_v1\n";
const BACKUP_SALT_LEN = 16;
const BACKUP_IV_LEN = 12;
const BACKUP_PBKDF2_ITERATIONS = 600_000;
const MIN_BACKUP_PASSWORD_LEN = 8;

async function deriveBackupKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const pwKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: BACKUP_PBKDF2_ITERATIONS, hash: "SHA-256" },
    pwKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function backupEncrypt(plaintext: Uint8Array, password: string): Promise<Uint8Array> {
  const magic = new TextEncoder().encode(BACKUP_MAGIC_STR);
  const salt = crypto.getRandomValues(new Uint8Array(BACKUP_SALT_LEN));
  const iv = crypto.getRandomValues(new Uint8Array(BACKUP_IV_LEN));
  const key = await deriveBackupKey(password, salt);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));
  const out = new Uint8Array(magic.length + salt.length + iv.length + ct.length);
  out.set(magic, 0);
  out.set(salt, magic.length);
  out.set(iv, magic.length + salt.length);
  out.set(ct, magic.length + salt.length + iv.length);
  return out;
}

async function backupDecrypt(data: Uint8Array, password: string): Promise<Uint8Array | null> {
  const magic = new TextEncoder().encode(BACKUP_MAGIC_STR);
  if (data.length < magic.length + BACKUP_SALT_LEN + BACKUP_IV_LEN + 1) return null;
  for (let i = 0; i < magic.length; i++) if (data[i] !== magic[i]) return null;
  let off = magic.length;
  const salt = data.slice(off, off + BACKUP_SALT_LEN); off += BACKUP_SALT_LEN;
  const iv = data.slice(off, off + BACKUP_IV_LEN); off += BACKUP_IV_LEN;
  const ct = data.slice(off);
  try {
    const key = await deriveBackupKey(password, salt);
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct));
  } catch {
    return null; // wrong password or tampered ciphertext
  }
}

// Diceware-style passphrase from the BIP-39 wordlist. 6 words = 66 bits
// of entropy (log2(2048^6)), well above the EFF "valuable accounts"
// recommendation. WebCrypto rejection-sampling avoids modulo bias on the
// non-power-of-2 wordlist length (2048 IS a power of 2 so this is just
// defense-in-depth — keeps the function honest if the list changes).
function generatePassphrase(numWords: number = 6): string {
  const words: string[] = [];
  const max = BIP39_WORDLIST.length;
  while (words.length < numWords) {
    const buf = crypto.getRandomValues(new Uint16Array(numWords - words.length));
    for (let i = 0; i < buf.length && words.length < numWords; i++) {
      const v = buf[i];
      if (v < 65536 - (65536 % max)) words.push(BIP39_WORDLIST[v % max]);
    }
  }
  return words.join("-");
}

function passwordStrength(pw: string): { label: string; cls: "ok" | "err" | "warn" | "" } {
  if (!pw) return { label: "", cls: "" };
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((re) => re.test(pw)).length;
  if (pw.length < MIN_BACKUP_PASSWORD_LEN) return { label: `Weak — use at least ${MIN_BACKUP_PASSWORD_LEN} characters`, cls: "err" };
  if (pw.length >= 12 || classes >= 3) return { label: "Strong", cls: "ok" };
  return { label: "OK — stronger with mixed character types", cls: "warn" };
}

// Builds the plaintext format mobile expects: JSON array of
// {dm: <hex datamap>, t: <title>, ts: <timestamp ms>}. Mirrors
// PrivateDataStore.exportAll on Android.
async function buildBackupPlaintext(): Promise<{ plaintext: Uint8Array; entries: number }> {
  const { wallet, key: storageKey } = await ensureStorageKey();
  const stored = loadPrivateEntries(wallet);
  const exported: Array<{ dm: string; t: string; ts: number }> = [];
  for (const e of stored) {
    try {
      const dm = await decryptDataMap(storageKey, e.cipher);
      exported.push({ dm, t: e.title, ts: e.ts * 1000 }); // ms for mobile compat
    } catch { /* skip undecryptable entries — wrong storage key */ }
  }
  return {
    plaintext: new TextEncoder().encode(JSON.stringify(exported)),
    entries: exported.length,
  };
}

// Imports entries from a decrypted backup plaintext into the local
// PrivateStore. Skips data-maps that already exist locally.
async function importBackupPlaintext(plaintext: Uint8Array): Promise<{ imported: number; skipped: number }> {
  let parsed: Array<{ dm?: unknown; t?: unknown; ts?: unknown }>;
  try {
    parsed = JSON.parse(new TextDecoder().decode(plaintext)) as Array<{ dm?: unknown; t?: unknown; ts?: unknown }>;
  } catch {
    throw new Error("Backup plaintext is not valid JSON.");
  }
  if (!Array.isArray(parsed)) throw new Error("Backup must be a JSON array.");

  const { wallet, key: storageKey } = await ensureStorageKey();
  const existing = loadPrivateEntries(wallet);
  const existingDms = new Set<string>();
  for (const e of existing) {
    try {
      const dm = await decryptDataMap(storageKey, e.cipher);
      existingDms.add(dm.toLowerCase());
    } catch { /* skip undecryptable */ }
  }

  let imported = 0, skipped = 0;
  for (const obj of parsed) {
    const dm = typeof obj.dm === "string" ? obj.dm : "";
    if (!dm) { skipped++; continue; }
    if (existingDms.has(dm.toLowerCase())) { skipped++; continue; }
    const title = typeof obj.t === "string" ? obj.t : "";
    const tsMs = typeof obj.ts === "number" ? obj.ts : Date.now();
    const cipher = await encryptDataMap(storageKey, dm);
    existing.push({
      id: newId(),
      title,
      ts: Math.floor(tsMs / 1000),
      size: 0,
      cipher,
    });
    existingDms.add(dm.toLowerCase());
    imported++;
  }
  savePrivateEntries(wallet, existing);
  renderPrivateEtches();
  return { imported, skipped };
}

// ── Failed-finalize recovery (Phase 3e) ──────────────────────────
//
// finalize_*_etch is the chunk-storage step. It can fail with a partial
// upload (some chunks stored, some not) when network nodes responsible
// for specific chunk addresses are unreachable.
//
// Recovery is *not* via retrying the same upload_id — ant-ffi's
// finalize_upload calls `take_pending(upload_id)` which removes the
// prepared state on first attempt, regardless of outcome. The upload_id
// is gone after that. Mobile has the same constraint.
//
// The actual recovery is to re-etch the same byte content. Autonomi is
// content-addressed; chunks that successfully stored on the previous
// attempt are recognized at the quote step and skipped, so the wallet
// only signs payment for the chunks that didn't land.
//
// We persist the original content + title + private flag so 'Retry'
// can re-run the etch flow without the user having to remember /
// re-paste anything.

type PendingFinalize = {
  isPrivate: boolean;
  text: string;
  title: string;
};

let pendingFinalize: PendingFinalize | null = null;

function persistPendingFinalize(): void {
  if (pendingFinalize) {
    localStorage.setItem("etchit:pending-finalize:v1", JSON.stringify(pendingFinalize));
  } else {
    localStorage.removeItem("etchit:pending-finalize:v1");
  }
}

function loadPendingFinalize(): void {
  try {
    const raw = localStorage.getItem("etchit:pending-finalize:v1");
    if (!raw) return;
    const parsed = JSON.parse(raw) as Partial<PendingFinalize>;
    // Be strict: drop entries from previous formats (which had upload_id /
    // payments / dataMap fields) — they're not retryable under the new
    // re-etch model.
    if (typeof parsed.text === "string" && typeof parsed.title === "string" && typeof parsed.isPrivate === "boolean") {
      pendingFinalize = parsed as PendingFinalize;
    } else {
      localStorage.removeItem("etchit:pending-finalize:v1");
    }
  } catch { pendingFinalize = null; }
}

function showFinalizeRetry(message: string): void {
  if (!pendingFinalize) return;
  const root = $("etchResult");
  root.innerHTML = "";
  const panel = document.createElement("div");
  panel.className = "etch-result";

  const heading = document.createElement("div");
  heading.style.color = "var(--copper)";
  heading.style.fontWeight = "500";
  heading.textContent = "Etch failed";
  panel.appendChild(heading);

  const desc = document.createElement("div");
  desc.className = "fetch-meta";
  desc.style.color = "var(--ash)";
  desc.style.marginTop = "4px";
  desc.style.marginBottom = "10px";
  desc.textContent = message;
  panel.appendChild(desc);

  const note = document.createElement("div");
  note.style.fontSize = "12px";
  note.style.color = "var(--bone)";
  note.style.padding = "8px 10px";
  note.style.borderLeft = "2px solid var(--copper)";
  note.style.marginBottom = "10px";
  note.textContent =
    "Re-etch will sign a fresh payment and try again. Autonomi is content-addressed: " +
    "any chunks from the previous attempt that did store are recognized at the quote step " +
    "and skipped, so the wallet payment covers only the chunks that haven't landed.";
  panel.appendChild(note);

  const actions = document.createElement("div");
  actions.style.display = "flex";
  actions.style.gap = "8px";

  const retryBtn = document.createElement("button");
  retryBtn.className = "outlined";
  retryBtn.style.borderColor = "var(--copper)";
  retryBtn.style.color = "var(--copper)";
  retryBtn.textContent = "Re-etch (dedup-aware)";
  retryBtn.onclick = () => { void retryFinalize(); };
  actions.appendChild(retryBtn);

  const dismissBtn = document.createElement("button");
  dismissBtn.className = "outlined";
  dismissBtn.textContent = "Dismiss";
  dismissBtn.onclick = () => {
    clearEtchAttempt();
    $("etchResult").innerHTML = "";
  };
  actions.appendChild(dismissBtn);

  panel.appendChild(actions);
  root.appendChild(panel);
}

async function retryFinalize(): Promise<void> {
  if (!pendingFinalize) return;
  const p = pendingFinalize;
  setEtchStatus("Re-etching with dedup…", "warn");
  $("etchResult").innerHTML = "";
  try {
    if (p.isPrivate) {
      const r = await etchPrivate(p.text, p.title);
      setEtchStatus("Done.", "ok");
      showPrivateEtchResult(r.id, r.chunks, p.title);
      renderPrivateEtches();
      const w = knownWallet();
      if (w) pushHistoryPrivate(w, r.id, p.title);
    } else {
      const r = await etchPublic(p.text, p.title);
      setEtchStatus("Done.", "ok");
      showEtchResult(r, p.title);
      const w = knownWallet();
      if (w) pushHistoryPublic(w, r.address, p.title);
    }
    clearEtchAttempt();
    void refreshAntBalance();
  } catch (e) {
    setEtchStatus(`Re-etch failed: ${(e as Error).message ?? String(e)}`, "err");
    showFinalizeRetry((e as Error).message ?? String(e));
  }
}

// ── Etch creation (Phase 3a) ─────────────────────────────────────

type PaymentDto = { quote_hash: string; rewards_address: string; amount: string };
type PreparedPublicEtch = { upload_id: string; payments: PaymentDto[]; total_amount: string; data_map_address: string };
type PublicEtchResult = { address: string; chunks_stored: number };

function setEtchStatus(msg: string, cls: "ok" | "err" | "warn" | "" = ""): void {
  const el = $("etchStatus");
  el.textContent = msg;
  el.className = "status" + (cls ? ` ${cls}` : "");
}

function buildEnvelope(content: string, title: string): Uint8Array {
  // Mirror PasteUtils.buildEnvelope on Android — deterministic JSON, no
  // timestamp (content is content-addressed; including time would break
  // network-side dedup of identical (content, title) pairs).
  const escape = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
  const json = `{"v":1,"meta":{"title":"${escape(title)}","lang":""},"content":"${escape(content)}"}`;
  return new TextEncoder().encode(json);
}

async function ethCall(to: string, data: string): Promise<string> {
  return await rpc.call({ to, data });
}

// Global "check your phone" banner. WalletConnect requests are
// invisible on desktop unless we tell the user to look — counter-based
// so concurrent calls don't flicker the banner off.
let walletPromptDepth = 0;
async function withWalletPrompt<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const banner = $("walletPrompt");
  $("walletPromptLabel").textContent = label + "…";
  walletPromptDepth++;
  banner.removeAttribute("hidden");
  try {
    return await fn();
  } finally {
    walletPromptDepth = Math.max(0, walletPromptDepth - 1);
    if (walletPromptDepth === 0) banner.setAttribute("hidden", "");
  }
}

// Some wallets (notably MetaMask Mobile) hold their own selected
// network independent of which chain the dapp wants to use. Without
// switching, eth_sendTransaction broadcasts on whatever chain the
// wallet's currently on — usually Ethereum mainnet — and shows
// "insufficient funds" even though the user has plenty of ETH on
// Arbitrum. Mirror EtchSigner.switchChain on Android.
async function ensureArbitrumChain(walletProvider: Eip1193Provider): Promise<void> {
  const target = "0x" + ARBITRUM_CHAIN_ID.toString(16);
  try {
    const current = (await walletProvider.request({ method: "eth_chainId" })) as string;
    if (current && current.toLowerCase() === target.toLowerCase()) return;
  } catch { /* fall through to switch */ }
  try {
    await walletProvider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: target }],
    });
  } catch (e) {
    // 4902 = chain not added to wallet. Most wallets bundle Arbitrum
    // by default so this is rare, but be defensive.
    const code = (e as { code?: number })?.code;
    if (code === 4902) {
      await walletProvider.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: target,
          chainName: "Arbitrum One",
          nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
          rpcUrls: [ARBITRUM_RPC],
          blockExplorerUrls: ["https://arbiscan.io"],
        }],
      });
    } else {
      throw e;
    }
  }
}

async function sendTx(walletProvider: Eip1193Provider, from: string, to: string, data: string, label: string): Promise<string> {
  await ensureArbitrumChain(walletProvider);
  return await withWalletPrompt(label, async () =>
    (await walletProvider.request({
      method: "eth_sendTransaction",
      params: [{ from, to, data }],
    })) as string,
  );
}

async function etchPublic(text: string, title: string): Promise<PublicEtchResult> {
  return await uploadPublicBytes(buildEnvelope(text, title), title);
}

// Status setter signature shared by every section that drives a status
// line (etch panel, backup section, etc). Lets uploadPublicBytes write
// its progress to whichever section initiated the upload.
type StatusSetter = (msg: string, cls?: "ok" | "err" | "warn" | "") => void;

// Shared raw-bytes upload path — used by etchPublic (envelope-wrapped
// text) and the backup flow (already-encrypted binary blob). Defaults
// to the etch panel's status; backup passes its own setter so the
// 'Finalizing upload…' spinner doesn't bleed into the etch panel.
async function uploadPublicBytes(
  data: Uint8Array,
  title: string,
  setStatus: StatusSetter = setEtchStatus,
): Promise<PublicEtchResult> {
  if (!inTauri) throw new Error("Etching requires the desktop app (no FFI in plain browser).");

  const account = appKit.getAccount() as AppKitAccount | undefined;
  if (!account?.isConnected || !account.address) throw new Error("Connect a wallet first.");
  const userAddress = account.address;

  const walletProvider = appKit.getWalletProvider() as Eip1193Provider | undefined;
  if (!walletProvider) throw new Error("Wallet provider unavailable.");

  checkCancelled();
  setStatus("Collecting quotes from network…", "warn");
  const prepared = await invoke<PreparedPublicEtch>("prepare_public_etch", { data: Array.from(data) });
  const totalAtto = BigInt(prepared.total_amount);

  checkCancelled();
  setStatus("Checking ANT allowance…", "warn");
  const allowanceCalldata = erc20Iface.encodeFunctionData("allowance", [userAddress, VAULT_ADDRESS]);
  const allowanceHex = await ethCall(ANT_TOKEN_ADDRESS, allowanceCalldata);
  const allowance = BigInt(allowanceHex);
  const needsApproval = allowance < totalAtto;

  if (needsApproval) {
    checkCancelled();
    setStatus("Approve ANT in your wallet…", "warn");
    const approveAmount = SESSION_BUDGET_ATTO > totalAtto ? SESSION_BUDGET_ATTO : totalAtto;
    const approveCalldata = erc20Iface.encodeFunctionData("approve", [VAULT_ADDRESS, approveAmount]);
    const approveHash = await sendTx(walletProvider, userAddress, ANT_TOKEN_ADDRESS, approveCalldata, "approve ANT spend in your wallet");
    setStatus(`Waiting for approve confirmation (${approveHash.slice(0, 10)}…)`, "warn");
    const approveReceipt = await rpc.waitForTransaction(approveHash);
    if (approveReceipt?.status !== 1) throw new Error(`ANT approve reverted (${approveHash})`);
  }

  checkCancelled();
  setStatus("Sign payment in your wallet…", "warn");
  const ensureHex = (s: string) => (s.startsWith("0x") || s.startsWith("0X") ? s : "0x" + s);
  const vaultPayments = prepared.payments.map((p) => [
    ensureHex(p.rewards_address),
    BigInt(p.amount),
    ensureHex(p.quote_hash),
  ]);
  const payCalldata = vaultIface.encodeFunctionData("payForQuotes", [vaultPayments]);
  const payHash = await sendTx(walletProvider, userAddress, VAULT_ADDRESS, payCalldata, "sign the etch payment in your wallet");
  // Past-the-point-of-no-return: payment is broadcast, can't unpay.
  if (etchCancel) etchCancel.afterPay = true;
  setCancelVisible(false);
  setStatus(`Waiting for payment confirmation (${payHash.slice(0, 10)}…)`, "warn");
  const payReceipt = await rpc.waitForTransaction(payHash);
  if (payReceipt?.status !== 1) throw new Error(`payForQuotes reverted (${payHash})`);

  setStatus("Finalizing upload — pushing chunks to network…", "warn");
  return await finalizePublic(prepared.upload_id, prepared.payments, payHash, title);
}

async function finalizePublic(uploadId: string, payments: PaymentDto[], payHash: string, _title: string): Promise<PublicEtchResult> {
  const txHashes: Record<string, string> = {};
  for (const p of payments) txHashes[p.quote_hash] = payHash;
  const result = await invoke<PublicEtchResult>("finalize_public_etch", {
    uploadId,
    txHashes,
  });
  return result;
}

function showEtchResult(result: PublicEtchResult, title: string): void {
  const root = $("etchResult");
  root.innerHTML = "";
  const panel = document.createElement("div");
  panel.className = "etch-result";

  const heading = document.createElement("div");
  heading.style.color = "var(--green)";
  heading.style.fontWeight = "500";
  heading.textContent = `Etched · ${result.chunks_stored} chunks stored`;
  panel.appendChild(heading);

  const addr = document.createElement("div");
  addr.className = "etch-result-addr";
  addr.textContent = result.address;
  panel.appendChild(addr);

  const libStatus = document.createElement("div");
  libStatus.className = "fetch-meta";
  libStatus.style.color = "var(--ash)";
  libStatus.style.marginBottom = "8px";
  panel.appendChild(libStatus);

  const actions = document.createElement("div");
  actions.style.display = "flex";
  actions.style.gap = "8px";
  actions.style.flexWrap = "wrap";

  const copyBtn = document.createElement("button");
  copyBtn.className = "outlined";
  copyBtn.textContent = "Copy address";
  copyBtn.onclick = () => {
    navigator.clipboard.writeText(result.address);
    setEtchStatus("Address copied", "ok");
  };
  actions.appendChild(copyBtn);

  const addBtn = document.createElement("button");
  addBtn.className = "outlined";
  addBtn.textContent = "Add to chainmarks";
  addBtn.onclick = async () => {
    addBtn.disabled = true;
    libStatus.style.color = "var(--ash)";
    try {
      if (!walletKeys) {
        // Derive on demand — same flow as Connect wallet, but without
        // running the full chain/it decode after.
        libStatus.textContent = "Sign chainmark-derive message in your wallet…";
        await connectAndDeriveKey();
      }
      libStatus.textContent = "Sign chainmark update in your wallet…";
      const txHash = await addToChainmarks(result.address, title || "");
      libStatus.style.color = "var(--copper)";
      libStatus.textContent = `Waiting for confirmation (${txHash.slice(0, 10)}…)`;
      const receipt = await rpc.waitForTransaction(txHash);
      if (receipt?.status === 1) {
        libStatus.style.color = "var(--green)";
        libStatus.textContent = `Added to chainmarks · ${txHash.slice(0, 10)}…`;
        addBtn.textContent = "Added";
      } else {
        libStatus.style.color = "var(--red)";
        libStatus.textContent = `Chainmark update reverted (${txHash})`;
        addBtn.disabled = false;
      }
    } catch (e) {
      libStatus.style.color = "var(--red)";
      libStatus.textContent = `Chainmark add failed: ${(e as Error).message ?? String(e)}`;
      addBtn.disabled = false;
    }
  };
  actions.appendChild(addBtn);

  panel.appendChild(actions);
  root.appendChild(panel);
}

type PreparedPrivateEtch = { upload_id: string; payments: PaymentDto[]; total_amount: string; data_map: string };
type PrivateEtchResult = { chunks_stored: number };

async function etchPrivate(text: string, title: string): Promise<{ id: string; chunks: number }> {
  if (!inTauri) throw new Error("Etching requires the desktop app (no FFI in plain browser).");

  const account = appKit.getAccount() as AppKitAccount | undefined;
  if (!account?.isConnected || !account.address) throw new Error("Connect a wallet first.");
  const userAddress = account.address;
  const walletProvider = appKit.getWalletProvider() as Eip1193Provider | undefined;
  if (!walletProvider) throw new Error("Wallet provider unavailable.");

  // Storage key is needed to encrypt the data-map at rest. Pre-derive
  // here so the wallet sign isn't a surprise mid-flow. The actual
  // encrypt + persist happens inside finalizePrivate after upload.
  checkCancelled();
  setEtchStatus("Sign private-storage message in your wallet (one-time)…", "warn");
  await ensureStorageKey();

  const data = buildEnvelope(text, title);

  checkCancelled();
  setEtchStatus("Collecting quotes from network…", "warn");
  const prepared = await invoke<PreparedPrivateEtch>("prepare_private_etch", { data: Array.from(data) });
  const totalAtto = BigInt(prepared.total_amount);

  checkCancelled();
  setEtchStatus("Checking ANT allowance…", "warn");
  const allowanceCalldata = erc20Iface.encodeFunctionData("allowance", [userAddress, VAULT_ADDRESS]);
  const allowance = BigInt(await ethCall(ANT_TOKEN_ADDRESS, allowanceCalldata));
  if (allowance < totalAtto) {
    checkCancelled();
    setEtchStatus("Approve ANT in your wallet…", "warn");
    const approveAmount = SESSION_BUDGET_ATTO > totalAtto ? SESSION_BUDGET_ATTO : totalAtto;
    const approveCalldata = erc20Iface.encodeFunctionData("approve", [VAULT_ADDRESS, approveAmount]);
    const approveHash = await sendTx(walletProvider, userAddress, ANT_TOKEN_ADDRESS, approveCalldata, "approve ANT spend in your wallet");
    setEtchStatus(`Waiting for approve confirmation (${approveHash.slice(0, 10)}…)`, "warn");
    const r = await rpc.waitForTransaction(approveHash);
    if (r?.status !== 1) throw new Error(`ANT approve reverted (${approveHash})`);
  }

  checkCancelled();
  setEtchStatus("Sign payment in your wallet…", "warn");
  const ensureHex = (s: string) => (s.startsWith("0x") || s.startsWith("0X") ? s : "0x" + s);
  const vaultPayments = prepared.payments.map((p) => [
    ensureHex(p.rewards_address),
    BigInt(p.amount),
    ensureHex(p.quote_hash),
  ]);
  const payCalldata = vaultIface.encodeFunctionData("payForQuotes", [vaultPayments]);
  const payHash = await sendTx(walletProvider, userAddress, VAULT_ADDRESS, payCalldata, "sign the etch payment in your wallet");
  // Past-the-point-of-no-return: payment is broadcast, can't unpay.
  if (etchCancel) etchCancel.afterPay = true;
  setCancelVisible(false);
  setEtchStatus(`Waiting for payment confirmation (${payHash.slice(0, 10)}…)`, "warn");
  const r = await rpc.waitForTransaction(payHash);
  if (r?.status !== 1) throw new Error(`payForQuotes reverted (${payHash})`);

  setEtchStatus("Finalizing upload — pushing chunks to network…", "warn");
  return await finalizePrivate(prepared.upload_id, prepared.payments, payHash, title, prepared.data_map, data.length);
}

async function finalizePrivate(uploadId: string, payments: PaymentDto[], payHash: string, title: string, dataMap: string, size: number): Promise<{ id: string; chunks: number }> {
  const txHashes: Record<string, string> = {};
  for (const p of payments) txHashes[p.quote_hash] = payHash;
  const result = await invoke<PrivateEtchResult>("finalize_private_etch", { uploadId, txHashes });

  // Finalize succeeded — persist the data-map locally.
  setEtchStatus("Saving data-map locally…", "warn");
  const { wallet: storageWallet, key: storageKey } = await ensureStorageKey();
  const id = newId();
  const cipher = await encryptDataMap(storageKey, dataMap);
  const entries = loadPrivateEntries(storageWallet);
  entries.push({ id, title: title || "", ts: Math.floor(Date.now() / 1000), size, cipher });
  savePrivateEntries(storageWallet, entries);

  return { id, chunks: result.chunks_stored };
}

async function fetchPrivateEntry(id: string): Promise<{ data: Uint8Array; title: string }> {
  const { wallet, key } = await ensureStorageKey();
  const entries = loadPrivateEntries(wallet);
  const entry = entries.find((e) => e.id === id);
  if (!entry) throw new Error("Entry not found locally.");
  const dataMapHex = await decryptDataMap(key, entry.cipher);
  const arr = await invoke<number[]>("fetch_private", { dataMapHex });
  return { data: Uint8Array.from(arr), title: entry.title };
}

// Paperclip — attach a text file. Mirrors mobile's TEXT_MIME_TYPES /
// MAX_ATTACHMENT_BYTES limits and behavior: validates UTF-8, loads
// content into the textarea, auto-fills title from filename if empty.
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

$("attachBtn").addEventListener("click", () => $<HTMLInputElement>("attachFileInput").click());
$("attachFileInput").addEventListener("change", async (ev) => {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  if (file.size > MAX_ATTACHMENT_BYTES) {
    setEtchStatus("File too large — max 20 MB", "err");
    return;
  }
  let text: string;
  try {
    const buf = await file.arrayBuffer();
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    setEtchStatus("File is not valid UTF-8 text", "err");
    return;
  }
  $<HTMLTextAreaElement>("etchText").value = text;
  const titleInput = $<HTMLInputElement>("etchTitle");
  if (!titleInput.value.trim() && file.name) titleInput.value = file.name;
  setEtchStatus(`Loaded ${file.name}`, "ok");
});

$("etchBtn").addEventListener("click", async () => {
  const text = $<HTMLTextAreaElement>("etchText").value;
  const title = $<HTMLInputElement>("etchTitle").value.trim();
  const isPrivate = $<HTMLInputElement>("etchPrivate").checked;
  if (!text.trim()) { setEtchStatus("Content is empty.", "err"); return; }

  setEtchPanelEnabled(false);
  etchCancel = { cancelled: false, afterPay: false };
  setCancelVisible(true);
  $("etchResult").innerHTML = "";
  try {
    markEtchAttempt(text, title, isPrivate);
    if (isPrivate) {
      const r = await etchPrivate(text, title);
      setEtchStatus("Done.", "ok");
      showPrivateEtchResult(r.id, r.chunks, title);
      renderPrivateEtches();
      const w = knownWallet();
      if (w) pushHistoryPrivate(w, r.id, title);
    } else {
      const r = await etchPublic(text, title);
      setEtchStatus("Done.", "ok");
      showEtchResult(r, title);
      const w = knownWallet();
      if (w) pushHistoryPublic(w, r.address, title);
    }
    clearEtchAttempt();
    void refreshAntBalance();
  } catch (e) {
    if (e instanceof EtchCancelled) {
      setEtchStatus("Cancelled.", "warn");
      clearEtchAttempt();
    } else {
      const msg = (e as Error).message ?? String(e);
      setEtchStatus(`Failed: ${msg}`, "err");
      if (pendingFinalize) showFinalizeRetry(msg);
    }
  } finally {
    setEtchPanelEnabled(true);
    setCancelVisible(false);
    etchCancel = null;
  }
});

// Mark the etch as "in flight" before we start so any failure leaves a
// retry handle. Cleared on full success at the end of each successful
// etch path.
function markEtchAttempt(text: string, title: string, isPrivate: boolean): void {
  pendingFinalize = { text, title, isPrivate };
  persistPendingFinalize();
}
function clearEtchAttempt(): void {
  pendingFinalize = null;
  persistPendingFinalize();
}

// User-cancellation token for in-flight etches. Checked at each async
// boundary in etchPublic / etchPrivate. Cancellation only meaningfully
// works BEFORE the payForQuotes broadcast — once payment is on-chain
// you can't unpay. The Cancel button hides itself after that point.
class EtchCancelled extends Error {
  constructor() { super("cancelled by user"); this.name = "EtchCancelled"; }
}
let etchCancel: { cancelled: boolean; afterPay: boolean } | null = null;
function checkCancelled(): void {
  if (etchCancel?.cancelled) throw new EtchCancelled();
}

function setEtchPanelEnabled(enabled: boolean): void {
  $<HTMLInputElement>("etchTitle").disabled = !enabled;
  $<HTMLTextAreaElement>("etchText").disabled = !enabled;
  $<HTMLInputElement>("etchPrivate").disabled = !enabled;
  $<HTMLButtonElement>("attachBtn").disabled = !enabled;
  $<HTMLButtonElement>("etchBtn").disabled = !enabled;
}

function setCancelVisible(visible: boolean): void {
  const btn = $<HTMLButtonElement>("etchCancelBtn");
  if (visible) btn.removeAttribute("hidden");
  else btn.setAttribute("hidden", "");
  btn.disabled = false;
}

$("etchCancelBtn").addEventListener("click", () => {
  if (!etchCancel || etchCancel.afterPay) return;
  etchCancel.cancelled = true;
  $<HTMLButtonElement>("etchCancelBtn").disabled = true;
  setEtchStatus("Cancelling…", "warn");
});

// Surface a stale pending-finalize on startup (page reload after a
// finalize failure) so the user has the Retry button available.
loadPendingFinalize();
if (pendingFinalize) showFinalizeRetry("Previous upload didn't finalize. Retry uses the existing payment.");

// Mirrors Terms.kt on Android. Same wording across clients. Declared
// here (not in initSettingsUI) so the first-launch terms gate below
// can read it without a temporal-dead-zone reference.
const TERMS_TEXT = `By using etchit you agree:

1. You own what you etch. Don't upload material that infringes copyright, violates the law, or that you don't have the right to share.

2. No illegal content. No CSAM, no malware, no content that harms others.

3. Etches are permanent. Once written to the Autonomi network, content cannot be deleted — by you, by us, or by anyone.

4. Your data map is the only key to a private etch. Treat it like a password — keep it secure, don't expose it. Loss or compromise means loss of privacy, and we cannot revoke access.

5. Your wallet, your keys, your costs. etchit never holds your private keys. You sign every transaction yourself, and you pay the gas and ANT cost.

6. No warranty. etchit is provided as-is. The Autonomi network and Arbitrum RPC are operated by third parties; we don't guarantee uptime, data availability, or recoverability.

7. No data recovery. If you lose a private data map, the content is gone. We cannot recover it.

8. You are responsible for what you post. etchit is a client app, not a host. We do not monitor, scan, or moderate content. Misuse is your liability.

9. No refunds for failed uploads. Network errors, app crashes, transaction failures, or any other technical issue during an etch may result in spent ANT or gas with no content stored. Blockchain transactions cannot be reversed and we cannot refund.`;

// Terms gate — first-launch modal. Mirrors mobile's Terms.ACCEPTED_KEY
// flag in SharedPreferences. Persists to localStorage; shown once.
const TERMS_ACCEPTED_KEY = "etchit:terms-accepted:v1";
function showTermsGateIfNeeded(): void {
  if (localStorage.getItem(TERMS_ACCEPTED_KEY)) return;
  $("termsGateText").textContent = TERMS_TEXT;
  $("termsGate").removeAttribute("hidden");
}
$("termsAcceptBtn").addEventListener("click", () => {
  localStorage.setItem(TERMS_ACCEPTED_KEY, "1");
  $("termsGate").setAttribute("hidden", "");
});
showTermsGateIfNeeded();

// ── Private etches list (Phase 3c) ───────────────────────────────

function showBackupResultPanel(address: string, entries: number): void {
  const root = $("backupResult");
  root.innerHTML = "";
  const panel = document.createElement("div");
  panel.className = "etch-result";

  const heading = document.createElement("div");
  heading.style.color = "var(--green)";
  heading.style.fontWeight = "500";
  heading.textContent = `Backup etched · ${entries} entr${entries === 1 ? "y" : "ies"} encrypted`;
  panel.appendChild(heading);

  const note = document.createElement("div");
  note.className = "fetch-meta";
  note.style.color = "var(--ash)";
  note.style.marginTop = "4px";
  note.textContent = "Save this address — with your password it's your recovery key on any device.";
  panel.appendChild(note);

  const addr = document.createElement("div");
  addr.className = "etch-result-addr";
  addr.textContent = address;
  panel.appendChild(addr);

  const copyBtn = document.createElement("button");
  copyBtn.className = "outlined";
  copyBtn.textContent = "Copy address";
  copyBtn.onclick = () => navigator.clipboard.writeText(address);
  panel.appendChild(copyBtn);

  root.appendChild(panel);
}

function showPrivateEtchResult(id: string, chunks: number, title: string): void {
  const root = $("etchResult");
  root.innerHTML = "";
  const panel = document.createElement("div");
  panel.className = "etch-result";

  const heading = document.createElement("div");
  heading.style.color = "var(--green)";
  heading.style.fontWeight = "500";
  heading.textContent = `Private etch · ${chunks} chunks stored · saved locally`;
  panel.appendChild(heading);

  const sub = document.createElement("div");
  sub.className = "fetch-meta";
  sub.style.color = "var(--ash)";
  sub.style.marginTop = "4px";
  sub.textContent = `id: ${id}${title ? ` · title: ${title}` : ""}`;
  panel.appendChild(sub);

  const warn = document.createElement("div");
  warn.style.marginTop = "10px";
  warn.style.padding = "8px 10px";
  warn.style.borderLeft = "2px solid var(--copper)";
  warn.style.fontSize = "12px";
  warn.style.color = "var(--bone)";
  warn.innerHTML =
    "<strong>Wallet-dependent.</strong> The data-map is encrypted with a key derived from " +
    "your wallet signature. If you lose access to this wallet (no seed phrase / no recovery), " +
    "this etch becomes permanently unreadable — there is no server backup.";
  panel.appendChild(warn);

  root.appendChild(panel);
}

function knownWallet(): string | null {
  // In-memory cache first; fall back to AppKit's persisted session
  // (survives page reloads / HMR refreshes via WalletConnect storage).
  if (walletKeys?.wallet) return walletKeys.wallet;
  const acct = appKit.getAccount() as AppKitAccount | undefined;
  if (acct?.isConnected && acct.address) return acct.address;
  return null;
}

function renderPrivateEtches(): void {
  const root = $("privateList");
  root.innerHTML = "";
  const wallet = knownWallet();
  if (!wallet) {
    const div = document.createElement("div");
    div.className = "empty";
    div.textContent = "Connect wallet to see private etches stored on this device.";
    root.appendChild(div);
    return;
  }
  const entries = loadPrivateEntries(wallet).slice().sort((a, b) => b.ts - a.ts);
  if (!entries.length) {
    const div = document.createElement("div");
    div.className = "empty";
    div.textContent = "No private etches on this device yet.";
    root.appendChild(div);
    return;
  }
  for (const e of entries) {
    const row = document.createElement("div");
    row.className = "row";

    const title = document.createElement("div");
    title.className = "title";
    title.textContent = e.title || "Untitled";
    row.appendChild(title);

    const meta = document.createElement("div");
    meta.className = "addr";
    meta.textContent = `id: ${e.id} · ${formatSize(e.size)} · ${new Date(e.ts * 1000).toLocaleString()}`;
    row.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "actions";

    const fetchBtn = document.createElement("button");
    fetchBtn.className = "outlined";
    fetchBtn.textContent = "Fetch";
    fetchBtn.onclick = async () => {
      fetchBtn.disabled = true;
      fetchBtn.textContent = "Fetching…";
      const existingOut = row.querySelector(".fetch-result");
      if (existingOut) existingOut.remove();
      const out = document.createElement("div");
      out.className = "fetch-result loading";
      out.textContent = "Fetching from network…";
      row.appendChild(out);
      try {
        const { data, title: t } = await fetchPrivateEntry(e.id);
        const detected = detectContent(data);
        out.innerHTML = "";
        out.classList.remove("loading");
        addCloseButton(out);
        const meta2 = document.createElement("div");
        meta2.className = "fetch-meta";
        meta2.textContent = `${detected.type} · ${formatSize(data.length)}`;
        out.appendChild(meta2);
        if (detected.type === "envelope") {
          const decoded = new TextDecoder().decode(data);
          const env = parseEnvelope(decoded);
          renderText(out, env.title || t, env.content);
        } else if (detected.type === "text") {
          renderText(out, t, new TextDecoder().decode(data));
        } else if (detected.type === "image") {
          const blob = new Blob([data as BlobPart], { type: detected.mime });
          const url = URL.createObjectURL(blob);
          const img = document.createElement("img");
          img.src = url;
          img.className = "fetch-img";
          out.appendChild(img);
        } else {
          appendError(out, `${detected.mime} — save to disk to view.`);
          addSaveButton(out, data, t, detected.ext);
        }
      } catch (err) {
        out.innerHTML = "";
        out.classList.remove("loading");
        appendError(out, `Fetch failed: ${(err as Error).message ?? String(err)}`);
        addCloseButton(out);
      } finally {
        fetchBtn.disabled = false;
        fetchBtn.textContent = "Fetch";
      }
    };
    actions.appendChild(fetchBtn);

    const delBtn = document.createElement("button");
    delBtn.className = "outlined";
    delBtn.textContent = "Delete";
    delBtn.onclick = () => {
      const w = knownWallet();
      if (!w) return;

      // Replace the action row with an inline two-step confirmation.
      // Inline (not a browser confirm()) so the warning text is fully
      // readable and can't be missed by an absent-minded enter-press.
      const original = actions.cloneNode(true);
      actions.innerHTML = "";

      const warn = document.createElement("div");
      warn.className = "fetch-err";
      warn.style.marginBottom = "8px";
      warn.textContent =
        "Permanent delete: the data-map is on this device only. " +
        "Once removed, this etch cannot be recovered — even with your wallet.";
      actions.appendChild(warn);

      const btnRow = document.createElement("div");
      btnRow.style.display = "flex";
      btnRow.style.gap = "6px";

      const cancelBtn = document.createElement("button");
      cancelBtn.className = "outlined";
      cancelBtn.textContent = "Cancel";
      cancelBtn.onclick = () => {
        actions.replaceWith(original as HTMLElement);
      };
      btnRow.appendChild(cancelBtn);

      const confirmBtn = document.createElement("button");
      confirmBtn.className = "outlined";
      confirmBtn.style.borderColor = "var(--red)";
      confirmBtn.style.color = "var(--red)";
      confirmBtn.textContent = "Delete forever";
      confirmBtn.onclick = () => {
        const w2 = knownWallet();
        if (!w2) return;
        const filtered = loadPrivateEntries(w2).filter((x) => x.id !== e.id);
        savePrivateEntries(w2, filtered);
        renderPrivateEtches();
      };
      btnRow.appendChild(confirmBtn);

      actions.appendChild(btnRow);
    };
    actions.appendChild(delBtn);

    row.appendChild(actions);
    root.appendChild(row);
  }
}

// ── Wallet bar (Phase 3c) ────────────────────────────────────────

function formatAnt(atto: bigint): string {
  const whole = atto / 10n ** 18n;
  const frac = (atto % 10n ** 18n) * 10000n / 10n ** 18n;
  return `${whole}.${frac.toString().padStart(4, "0")}`;
}

async function fetchAntBalance(address: string): Promise<bigint | null> {
  try {
    const calldata = erc20Iface.encodeFunctionData("balanceOf", [address]);
    const result = await ethCall(ANT_TOKEN_ADDRESS, calldata);
    return BigInt(result);
  } catch {
    return null;
  }
}

let lastBalanceAddr: string | null = null;
function setWalletBarText(text: string, ok: boolean): void {
  const status = $("walletStatus");
  status.textContent = text;
  if (ok) status.classList.add("ok");
  else status.classList.remove("ok");
}

async function refreshWalletBar(): Promise<void> {
  const acct = appKit.getAccount() as AppKitAccount | undefined;
  const btn = $<HTMLButtonElement>("walletBtn");
  if (acct?.isConnected && acct.address) {
    const short = `${acct.address.slice(0, 6)}…${acct.address.slice(-4)}`;
    setWalletBarText(`Wallet: ${short}`, true);
    btn.textContent = "Manage";
    if (lastBalanceAddr !== acct.address) {
      lastBalanceAddr = acct.address;
      const bal = await fetchAntBalance(acct.address);
      // Recheck — connection may have flipped during the network call.
      const stillConnected = (appKit.getAccount() as AppKitAccount | undefined);
      if (bal !== null && stillConnected?.address === acct.address) {
        setWalletBarText(`Wallet: ${short} · ${formatAnt(bal)} ANT`, true);
      }
    }
  } else {
    setWalletBarText("Wallet: not connected", false);
    btn.textContent = "Connect";
    lastBalanceAddr = null;
    // Wallet has been cleared; drop any cached derived keys so a
    // reconnect or different wallet doesn't reuse them.
    walletKeys = null;
  }
}

async function refreshAntBalance(): Promise<void> {
  const acct = appKit.getAccount() as AppKitAccount | undefined;
  if (!acct?.isConnected || !acct.address) return;
  const bal = await fetchAntBalance(acct.address);
  if (bal === null) return;
  const stillConnected = (appKit.getAccount() as AppKitAccount | undefined);
  if (stillConnected?.address !== acct.address) return;
  const short = `${acct.address.slice(0, 6)}…${acct.address.slice(-4)}`;
  setWalletBarText(`Wallet: ${short} · ${formatAnt(bal)} ANT`, true);
}

$("walletBtn").addEventListener("click", () => {
  void appKit.open();
});

setInterval(() => { void refreshAntBalance(); }, 30_000);

// ── Settings (Phase 3d) ──────────────────────────────────────────

function initSettingsUI(): void {
  $("termsText").textContent = TERMS_TEXT;

  // Bootstrap peers
  const peersInput = $<HTMLTextAreaElement>("bootstrapPeers");
  const savedPeers = localStorage.getItem("etchit:bootstrap-peers:v1");
  peersInput.value = savedPeers ?? DEFAULT_BOOTSTRAP_TEXT;

  const setPeersStatus = (msg: string, cls: "ok" | "err" | "warn" | "" = "") => {
    const el = $("peersStatus");
    el.textContent = msg;
    el.className = "status" + (cls ? ` ${cls}` : "");
  };

  $("savePeersBtn").addEventListener("click", async () => {
    const v = peersInput.value.trim();
    if (v && v !== DEFAULT_BOOTSTRAP_TEXT) {
      localStorage.setItem("etchit:bootstrap-peers:v1", v);
    } else {
      localStorage.removeItem("etchit:bootstrap-peers:v1");
    }
    setPeersStatus("saved — reconnecting…", "warn");
    try {
      if (inTauri) await invoke("disconnect");
      await autoConnect();
      setPeersStatus("reconnected", "ok");
    } catch (e) {
      setPeersStatus(`reconnect failed: ${(e as Error).message ?? String(e)}`, "err");
    }
  });

  $("resetPeersBtn").addEventListener("click", () => {
    peersInput.value = DEFAULT_BOOTSTRAP_TEXT;
    localStorage.removeItem("etchit:bootstrap-peers:v1");
    setPeersStatus("reset to defaults — click Save to reconnect.", "warn");
  });

  // Indexer URL
  const indexerInput = $<HTMLInputElement>("indexer");
  const savedIndexer = readSavedIndexer();
  if (savedIndexer) indexerInput.value = savedIndexer;

  const setIndexerStatus = (msg: string, cls: "ok" | "err" | "warn" | "" = "") => {
    const el = $("indexerStatus");
    el.textContent = msg;
    el.className = "status" + (cls ? ` ${cls}` : "");
  };

  $("saveIndexerBtn").addEventListener("click", () => {
    const v = indexerInput.value.trim();
    if (!/^https?:\/\//.test(v)) {
      setIndexerStatus("URL must start with http:// or https://", "err");
      return;
    }
    localStorage.setItem("etchit:indexer-url:v1", v);
    setIndexerStatus("saved", "ok");
  });

  // Chainmark key — backup / restore
  const libKeyOut = $("chainmarkKeyOutput");
  const setLibKeyStatus = (msg: string, cls: "ok" | "err" | "warn" | "" = "") => {
    const el = $("chainmarkKeyStatus");
    el.textContent = msg;
    el.className = "status" + (cls ? ` ${cls}` : "");
  };

  let chainmarkKeyVisible = false;
  const showBtn = $<HTMLButtonElement>("showChainmarkKeyBtn");
  const hideKey = (): void => {
    libKeyOut.innerHTML = "";
    chainmarkKeyVisible = false;
    showBtn.textContent = "Show chainmark key";
  };

  showBtn.addEventListener("click", async () => {
    if (chainmarkKeyVisible) { hideKey(); return; }
    setLibKeyStatus("");
    libKeyOut.innerHTML = "";
    try {
      const { key } = await ensureChainmarkKey();
      const hex = bytesToHex(key);

      const block = document.createElement("div");
      block.className = "fetch-result";

      const warn = document.createElement("div");
      warn.className = "fetch-meta";
      warn.style.color = "var(--copper)";
      warn.style.marginBottom = "6px";
      warn.textContent = "Treat this like a password. Anyone with this key + your wallet address can read your chainmarks.";
      block.appendChild(warn);

      const code = document.createElement("div");
      code.style.fontFamily = "ui-monospace, Menlo, Consolas, monospace";
      code.style.fontSize = "12px";
      code.style.wordBreak = "break-all";
      code.style.padding = "8px 10px";
      code.style.background = "var(--ink)";
      code.style.borderRadius = "4px";
      code.textContent = hex;
      block.appendChild(code);

      const copyBtn = document.createElement("button");
      copyBtn.className = "outlined";
      copyBtn.textContent = "Copy key";
      copyBtn.style.marginTop = "8px";
      copyBtn.onclick = () => {
        navigator.clipboard.writeText(hex);
        setLibKeyStatus("copied", "ok");
      };
      block.appendChild(copyBtn);

      libKeyOut.appendChild(block);
      chainmarkKeyVisible = true;
      showBtn.textContent = "Hide chainmark key";
    } catch (e) {
      setLibKeyStatus(`failed: ${(e as Error).message ?? String(e)}`, "err");
    }
  });

  $("forgetChainmarkBtn").addEventListener("click", () => {
    walletKeys = null;
    hideKey();
    currentChainmarks = [];
    $("results").innerHTML = "";
    setLibKeyStatus("forgotten — keys re-derive on next sign", "ok");
  });

  // Backup private etches
  const pwInput = $<HTMLInputElement>("backupPassword");
  const pwConfirmInput = $<HTMLInputElement>("backupPasswordConfirm");
  const pwStrengthEl = $("backupPwStrength");
  const setBackupStatus = (msg: string, cls: "ok" | "err" | "warn" | "" = "") => {
    const el = $("backupStatus");
    el.textContent = msg;
    el.className = "status" + (cls ? ` ${cls}` : "");
  };

  pwInput.addEventListener("input", () => {
    const s = passwordStrength(pwInput.value);
    pwStrengthEl.textContent = s.label;
    pwStrengthEl.className = "status" + (s.cls ? ` ${s.cls}` : "");
  });

  $("generatePassphraseBtn").addEventListener("click", () => {
    const phrase = generatePassphrase(6);
    pwInput.type = "text";
    pwConfirmInput.type = "text";
    pwInput.value = phrase;
    pwConfirmInput.value = phrase;
    pwInput.dispatchEvent(new Event("input"));

    // Inline reveal panel — the whole point of generating it is that the
    // user has to write it down before it goes back into a password field.
    let panel = document.getElementById("backupPassphraseReveal");
    if (panel) panel.remove();
    panel = document.createElement("div");
    panel.id = "backupPassphraseReveal";
    panel.className = "fetch-result";
    panel.style.marginTop = "10px";

    const title = document.createElement("div");
    title.className = "fetch-meta";
    title.style.color = "var(--copper)";
    title.textContent = "Generated passphrase — write it down before you submit";
    panel.appendChild(title);

    const code = document.createElement("div");
    code.style.fontFamily = "ui-monospace, Menlo, Consolas, monospace";
    code.style.fontSize = "13px";
    code.style.wordBreak = "break-all";
    code.style.padding = "10px 12px";
    code.style.background = "var(--ink)";
    code.style.borderRadius = "4px";
    code.style.margin = "8px 0";
    code.textContent = phrase;
    panel.appendChild(code);

    const actions = document.createElement("div");
    actions.style.display = "flex";
    actions.style.gap = "8px";
    actions.style.alignItems = "center";

    const copyBtn = document.createElement("button");
    copyBtn.className = "outlined";
    copyBtn.textContent = "Copy";
    copyBtn.onclick = () => { navigator.clipboard.writeText(phrase); copyBtn.textContent = "Copied"; };
    actions.appendChild(copyBtn);

    const hideBtn = document.createElement("button");
    hideBtn.className = "outlined";
    hideBtn.textContent = "Hide";
    hideBtn.onclick = () => {
      pwInput.type = "password";
      pwConfirmInput.type = "password";
      panel.remove();
    };
    actions.appendChild(hideBtn);

    panel.appendChild(actions);
    pwConfirmInput.parentElement?.insertBefore(panel, pwConfirmInput.nextSibling);
  });

  // Validates the password fields and saved-confirmation checkbox; on
  // success returns {plaintext, entries, encrypted} ready to be either
  // etched or saved to disk. Sets status on failure and returns null.
  async function prepareBackupBlob(): Promise<{ encrypted: Uint8Array; entries: number } | null> {
    const pw = pwInput.value;
    const pwConfirm = pwConfirmInput.value;
    const savedCheckbox = $<HTMLInputElement>("backupPasswordSaved");
    if (pw.length < MIN_BACKUP_PASSWORD_LEN) {
      setBackupStatus(`Password too short (min ${MIN_BACKUP_PASSWORD_LEN}).`, "err"); return null;
    }
    if (pw !== pwConfirm) {
      setBackupStatus("Passwords don't match.", "err"); return null;
    }
    if (!savedCheckbox.checked) {
      setBackupStatus("Confirm you've saved the password somewhere safe.", "err"); return null;
    }
    setBackupStatus("Building plaintext…", "warn");
    const { plaintext, entries } = await buildBackupPlaintext();
    if (entries === 0) {
      setBackupStatus("No private etches to back up.", "err"); return null;
    }
    setBackupStatus(`Encrypting ${entries} entr${entries === 1 ? "y" : "ies"}…`, "warn");
    const encrypted = await backupEncrypt(plaintext, pw);
    return { encrypted, entries };
  }

  function clearBackupForm(): void {
    pwInput.value = "";
    pwConfirmInput.value = "";
    pwStrengthEl.textContent = "";
    pwStrengthEl.className = "status";
    $<HTMLInputElement>("backupPasswordSaved").checked = false;
  }

  $("createBackupBtn").addEventListener("click", async () => {
    const btn = $<HTMLButtonElement>("createBackupBtn");
    btn.disabled = true;
    $("backupResult").innerHTML = "";
    try {
      const prep = await prepareBackupBlob();
      if (!prep) return;
      setBackupStatus(`Etching ${formatSize(prep.encrypted.length)} backup…`, "warn");
      const result = await uploadPublicBytes(prep.encrypted, "Backup", setBackupStatus);
      setBackupStatus("Done.", "ok");
      showBackupResultPanel(result.address, prep.entries);
      clearBackupForm();
      const w = knownWallet();
      if (w) pushHistoryPublic(w, result.address, "Backup");
      void refreshAntBalance();
    } catch (e) {
      setBackupStatus(`Failed: ${(e as Error).message ?? String(e)}`, "err");
    } finally {
      btn.disabled = false;
    }
  });

  $("downloadBackupBtn").addEventListener("click", async () => {
    const btn = $<HTMLButtonElement>("downloadBackupBtn");
    btn.disabled = true;
    $("backupResult").innerHTML = "";
    try {
      const prep = await prepareBackupBlob();
      if (!prep) return;
      const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      const defaultName = `etchit-backup-${ts}.etchitbk`;
      setBackupStatus("Choose where to save…", "warn");
      const path = await save({ defaultPath: defaultName });
      if (!path) { setBackupStatus("Cancelled.", "warn"); return; }
      setBackupStatus("Writing file…", "warn");
      await invoke("save_bytes", { path, bytes: Array.from(prep.encrypted) });
      setBackupStatus(`Saved · ${prep.entries} entr${prep.entries === 1 ? "y" : "ies"} encrypted · ${path}`, "ok");
      clearBackupForm();
    } catch (e) {
      setBackupStatus(`Failed: ${(e as Error).message ?? String(e)}`, "err");
    } finally {
      btn.disabled = false;
    }
  });

  // Restore private etches from a backup address
  const restorePassphrase = buildPassphraseEntry($("restorePassphraseSlot"));
  const setRestoreStatus = (msg: string, cls: "ok" | "err" | "warn" | "" = "") => {
    const el = $("restoreStatus");
    el.textContent = msg;
    el.className = "status" + (cls ? ` ${cls}` : "");
  };
  async function performRestore(bytes: Uint8Array, pw: string): Promise<void> {
    const detected = detectContent(bytes);
    if (detected.type !== "backup") {
      setRestoreStatus("That data isn't an encrypted etchit backup.", "err"); return;
    }
    setRestoreStatus("Decrypting…", "warn");
    const plaintext = await backupDecrypt(bytes, pw);
    if (!plaintext) {
      setRestoreStatus("Decrypt failed — wrong passphrase or corrupted backup.", "err"); return;
    }
    setRestoreStatus("Importing into local private store…", "warn");
    const { imported, skipped } = await importBackupPlaintext(plaintext);
    setRestoreStatus(`Restored ${imported} new entr${imported === 1 ? "y" : "ies"}${skipped ? ` (skipped ${skipped} duplicate${skipped === 1 ? "" : "s"})` : ""}.`, "ok");
    restorePassphrase.clear();
  }

  $("restoreBackupBtn").addEventListener("click", async () => {
    const addrRaw = $<HTMLInputElement>("restoreAddr").value.trim().toLowerCase().replace(/^0x/, "");
    const pw = restorePassphrase.getValue();
    if (!/^[0-9a-f]{64}$/.test(addrRaw)) { setRestoreStatus("Invalid address (need 64 hex chars).", "err"); return; }
    if (!pw) { setRestoreStatus("Passphrase is required.", "err"); return; }
    if (!inTauri) { setRestoreStatus("Restore from network requires the desktop app (no FFI in plain browser).", "err"); return; }

    const btn = $<HTMLButtonElement>("restoreBackupBtn");
    btn.disabled = true;
    try {
      setRestoreStatus("Fetching backup from network…", "warn");
      const arr = await invoke<number[]>("fetch_public", { addrHex: addrRaw });
      await performRestore(Uint8Array.from(arr), pw);
    } catch (e) {
      setRestoreStatus(`Failed: ${(e as Error).message ?? String(e)}`, "err");
    } finally {
      btn.disabled = false;
    }
  });

  // Restore-from-file: pick a local .etchitbk, decrypt with password, import
  let pendingRestoreFile: File | null = null;
  $("pickRestoreFileBtn").addEventListener("click", () => $<HTMLInputElement>("restoreFileInput").click());
  $("restoreFileInput").addEventListener("change", async (ev) => {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    pendingRestoreFile = file;
    $("restoreFileLabel").textContent = `${file.name} · ${formatSize(file.size)} · enter password and click below`;

    // Replace label area with an explicit Restore button that uses this file
    const labelEl = $("restoreFileLabel");
    if (labelEl.nextElementSibling?.id === "restoreFromFileBtn") return; // already added
    const restoreBtn = document.createElement("button");
    restoreBtn.id = "restoreFromFileBtn";
    restoreBtn.style.marginLeft = "8px";
    restoreBtn.textContent = "Restore from file";
    restoreBtn.onclick = async () => {
      if (!pendingRestoreFile) { setRestoreStatus("No file selected.", "err"); return; }
      const pw = restorePassphrase.getValue();
      if (!pw) { setRestoreStatus("Passphrase is required.", "err"); return; }
      restoreBtn.disabled = true;
      try {
        setRestoreStatus("Reading file…", "warn");
        const bytes = new Uint8Array(await pendingRestoreFile.arrayBuffer());
        await performRestore(bytes, pw);
      } catch (e) {
        setRestoreStatus(`Failed: ${(e as Error).message ?? String(e)}`, "err");
      } finally {
        restoreBtn.disabled = false;
      }
    };
    labelEl.parentElement?.appendChild(restoreBtn);
  });

  // Etch history
  const setHistoryStatus = (msg: string, cls: "ok" | "err" | "warn" | "" = "") => {
    const el = $("historyStatus");
    el.textContent = msg;
    el.className = "status" + (cls ? ` ${cls}` : "");
  };

  $("clearHistoryBtn").addEventListener("click", () => {
    const w = knownWallet();
    if (!w) { setHistoryStatus("connect wallet first", "err"); return; }
    localStorage.removeItem(historyStoreKey(w));
    renderHistory();
    setHistoryStatus("cleared", "ok");
  });

  renderHistory();
}

function relativeTime(unixSec: number): string {
  const diff = Math.floor(Date.now() / 1000) - unixSec;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return new Date(unixSec * 1000).toLocaleDateString();
}

function renderHistory(): void {
  const root = $("historyList");
  root.innerHTML = "";
  const wallet = knownWallet();
  if (!wallet) {
    const div = document.createElement("div");
    div.className = "empty";
    div.textContent = "Connect wallet to see etch history.";
    root.appendChild(div);
    return;
  }
  const entries = loadHistory(wallet);
  if (!entries.length) {
    const div = document.createElement("div");
    div.className = "empty";
    div.textContent = "No etches yet.";
    root.appendChild(div);
    return;
  }
  for (const e of entries) {
    const row = document.createElement("div");
    row.className = "row";

    const title = document.createElement("div");
    title.className = "title";
    title.textContent = (e.isPrivate ? "🔒 " : "") + (e.title || "Untitled");
    row.appendChild(title);

    const meta = document.createElement("div");
    meta.className = "addr";
    if (e.isPrivate) {
      meta.textContent = `private id: ${e.privateId} · ${relativeTime(e.ts)}`;
    } else {
      meta.textContent = `${e.address} · ${relativeTime(e.ts)}`;
    }
    row.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "actions";

    if (!e.isPrivate && e.address) {
      const copyAddr = document.createElement("button");
      copyAddr.className = "outlined";
      copyAddr.textContent = "Copy address";
      copyAddr.onclick = () => {
        navigator.clipboard.writeText(e.address!);
      };
      actions.appendChild(copyAddr);
    }

    row.appendChild(actions);
    root.appendChild(row);
  }
}

initSettingsUI();

// Refresh on load + whenever AppKit's account state changes (covers
// late-loading persisted sessions and live disconnects).
//
// subscribeAccount fires on every account-state update — including
// balance refreshes — so re-rendering the list unconditionally would
// orphan in-flight fetch result nodes. Only re-render when the wallet
// identity actually changes.
let lastRenderedWallet: string | null = null;
function maybeRerenderPrivate(): void {
  const wallet = knownWallet();
  if (wallet !== lastRenderedWallet) {
    lastRenderedWallet = wallet;
    renderPrivateEtches();
    renderHistory();
  }
}

renderPrivateEtches();
lastRenderedWallet = knownWallet();
void refreshWalletBar();
appKit.subscribeAccount(() => {
  void refreshWalletBar();
  maybeRerenderPrivate();
});

function appendError(parent: HTMLElement, msg: string): void {
  const e = document.createElement("div");
  e.className = "fetch-err";
  e.textContent = msg;
  parent.appendChild(e);
}

function addCloseButton(panel: HTMLElement): void {
  const btn = document.createElement("button");
  btn.className = "fetch-close";
  btn.title = "Close";
  btn.textContent = "×";
  btn.onclick = () => panel.remove();
  panel.appendChild(btn);
}

function suggestedFilename(title: string, ext: string): string {
  const safe = (title || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "etch";
  return safe.includes(".") ? safe : `${safe}.${ext}`;
}

function addSaveButton(parent: HTMLElement, bytes: Uint8Array, title: string, ext: string): void {
  const wrap = document.createElement("div");
  wrap.style.marginTop = "8px";
  const btn = document.createElement("button");
  btn.className = "outlined";
  btn.textContent = "Save to file…";
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
      const path = await save({ defaultPath: suggestedFilename(title, ext) });
      if (!path) { btn.disabled = false; btn.textContent = "Save to file…"; return; }
      // Tauri command takes Vec<u8>; serialize as plain number array.
      await invoke("save_bytes", { path, bytes: Array.from(bytes) });
      btn.textContent = "Saved";
      const note = document.createElement("div");
      note.className = "fetch-meta";
      note.style.color = "var(--green)";
      note.style.marginTop = "6px";
      note.textContent = `→ ${path}`;
      wrap.appendChild(note);
    } catch (e) {
      btn.disabled = false;
      btn.textContent = "Save to file…";
      appendError(wrap, `Save failed: ${(e as Error).message ?? String(e)}`);
    }
  };
  wrap.appendChild(btn);
  parent.appendChild(wrap);
}
