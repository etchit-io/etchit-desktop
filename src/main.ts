// etchit desktop frontend.
//
// Library viewer ported from tools/library.html in etchit-android-v3.
// Phase 2 wires the Tauri Rust backend (ant-ffi) so content can be
// fetched in-app instead of shelling out to ant-cli.

import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { createAppKit } from "@reown/appkit";
import { EthersAdapter } from "@reown/appkit-adapter-ethers";
import { arbitrum } from "@reown/appkit/networks";
import { Interface, JsonRpcProvider, type Eip1193Provider } from "ethers";

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
const RECIPIENT_PREFIX = new TextEncoder().encode("etchit-library-v1/recipient");

// =================================================================
//  FROZEN — library v1 protocol message (cross-client contract)
// =================================================================
// Locked in docs/library-format-v1.md (§4.1). Mobile (Kotlin),
// web viewer (JS), Python CLI, and this client must all sign the
// SAME bytes — otherwise the derived key differs and cross-device
// library sync breaks.
//
// 137 bytes UTF-8.
// SHA-256: 5163bfeff8f6fa44563730938abbe6a23b35aa890868754e22ff15af7666c0d5
// =================================================================
const SIGN_MESSAGE =
  "etchit library v1\n\n" +
  "Sign this message to derive your encrypted-library key. " +
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
// CLI hash the same string. Any edit silently breaks library sync.
const HKDF_INFO = new TextEncoder().encode("etchit-library/v1/aead-key");

// Defence-in-depth: hash the frozen sign messages at startup and abort
// loudly if either has drifted. A silent edit to either string would
// silently change the derived keys and corrupt user data; this turns
// that into a hard failure instead.
const SIGN_MESSAGE_SHA256 = "5163bfeff8f6fa44563730938abbe6a23b35aa890868754e22ff15af7666c0d5";
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
      `Library cross-device sync is broken. Revert the message or bump the protocol version.`,
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
// library key doesn't leak data-maps and vice-versa. Any edit silently
// makes existing private etches undecryptable. Bump v1 -> v2 + add a
// migration if you need to change.
const HKDF_INFO_PRIVATE_STORAGE = new TextEncoder().encode("etchit-private-storage/v1/data-map-key");

type LibraryEntry = {
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

function applyEntries(state: Map<string, LibraryEntry>, entries: WireEntry[]): void {
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

async function fetchAndDecode(walletAddr: string, keyMaterial: Uint8Array, indexerBase: string): Promise<LibraryEntry[]> {
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

  const state = new Map<string, LibraryEntry>();
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

// Cached wallet-derived keys. Library and private-storage are derived
// from independent personal_sign calls (different messages) so a user
// who signs one isn't unknowingly authorizing the other.
let walletKeys: { wallet: string; libraryKey?: Uint8Array; storageKey?: Uint8Array } | null = null;

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

async function ensureLibraryKey(): Promise<{ wallet: string; key: Uint8Array }> {
  if (walletKeys?.libraryKey) return { wallet: walletKeys.wallet, key: walletKeys.libraryKey };
  const key = await signAndDerive(SIGN_MESSAGE, HKDF_INFO, "sign the library-derive message in your wallet");
  walletKeys = { ...(walletKeys ?? { wallet: (await ensureWalletConnected()).wallet }), libraryKey: key };
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
  return await ensureLibraryKey();
}

// ── Library write (Phase 3b) ─────────────────────────────────────
//
// Mirrors LibraryCrypto.seal + LibrarySync.sendBatch on Android. Encodes
// a one-entry payload, AES-GCM-seals it with bucket padding, computes the
// per-tx recipient, and sends a 0-value Arbitrum tx via the wallet.

async function sealLibraryBatch(key: Uint8Array, payload: Uint8Array): Promise<Uint8Array | null> {
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

type LibraryAction = "add" | "bookmark" | "hide";

async function addToLibrary(addr: string, title: string, action: LibraryAction = "add"): Promise<string> {
  const { wallet, key } = await ensureLibraryKey();
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
  const blob = await sealLibraryBatch(key, payload);
  if (!blob) throw new Error("Library entry too large for max bucket.");

  const recipient = await recipientForBlob(blob);
  const calldata = "0x" + bytesToHex(blob);
  return await withWalletPrompt("sign the library update in your wallet", async () =>
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

function render(entries: LibraryEntry[]): void {
  const root = $("results");
  root.innerHTML = "";
  const visible = entries.filter((e) => !e.hidden).sort((a, b) => b.ts - a.ts);
  if (!visible.length) {
    const div = document.createElement("div");
    div.className = "empty";
    div.textContent = "Library is empty (or all entries are hidden).";
    root.appendChild(div);
    return;
  }
  for (const e of visible) {
    const row = document.createElement("div");
    row.className = "row" + (e.bookmark ? " bookmark" : "");

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

    row.appendChild(actions);
    root.appendChild(row);
  }
}

async function runDecode(wallet: string, keyBytes: Uint8Array): Promise<void> {
  const indexer = $<HTMLInputElement>("indexer").value.trim();
  setStatus("status", "Fetching from indexer…");
  $("results").innerHTML = "";
  const entries = await fetchAndDecode(wallet, keyBytes, indexer);
  render(entries);
  const visible = entries.filter((e) => !e.hidden).length;
  setStatus("status", `Decoded ${entries.length} entries (${visible} visible).`, "ok");
}

$("toggleKey").addEventListener("click", () => {
  const inp = $<HTMLInputElement>("key");
  const btn = $("toggleKey");
  if (inp.type === "password") { inp.type = "text"; btn.textContent = "Hide"; }
  else { inp.type = "password"; btn.textContent = "Show"; }
});

$("connect").addEventListener("click", async () => {
  setStatus("connectStatus", "");
  setStatus("status", "");
  const btn = $<HTMLButtonElement>("connect");
  btn.disabled = true;
  try {
    setStatus("connectStatus", "Requesting wallet connection…");
    const { wallet, key } = await connectAndDeriveKey();
    setStatus("connectStatus", `Connected ${wallet.slice(0, 6)}…${wallet.slice(-4)}`, "ok");
    await runDecode(wallet, key);
  } catch (e) {
    setStatus("connectStatus", `Failed: ${(e as Error).message}`, "err");
  } finally {
    btn.disabled = false;
  }
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
    return setStatus("status", `Invalid library key (need 64 hex chars, got ${keyHex.length}).`, "err");
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

async function autoConnect(): Promise<void> {
  if (!inTauri) {
    setNetStatus("not running inside Tauri (no FFI)", "warn");
    return;
  }
  setNetStatus("connecting…", "warn");
  try {
    await invoke<number>("connect", {});
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
  out.className = "fetch-result";
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
    appendError(out, `Fetch failed: ${(e as Error).message ?? String(e)}`);
    return;
  }

  const detected = detectContent(bytes);
  out.innerHTML = "";
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
      appendError(out, "Encrypted backup file — password decrypt not yet implemented in desktop.");
      addSaveButton(out, bytes, fallbackTitle, "etchit-backup");
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

function newId(): string {
  // Random 8-byte hex id for local-only references; collision-tolerant
  // since it's a per-wallet local index.
  return bytesToHex(crypto.getRandomValues(new Uint8Array(8)));
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

async function sendTx(walletProvider: Eip1193Provider, from: string, to: string, data: string, label: string): Promise<string> {
  return await withWalletPrompt(label, async () =>
    (await walletProvider.request({
      method: "eth_sendTransaction",
      params: [{ from, to, data }],
    })) as string,
  );
}

async function etchPublic(text: string, title: string): Promise<PublicEtchResult> {
  if (!inTauri) throw new Error("Etching requires the desktop app (no FFI in plain browser).");

  const account = appKit.getAccount() as AppKitAccount | undefined;
  if (!account?.isConnected || !account.address) throw new Error("Connect a wallet first.");
  const userAddress = account.address;

  const walletProvider = appKit.getWalletProvider() as Eip1193Provider | undefined;
  if (!walletProvider) throw new Error("Wallet provider unavailable.");

  const data = buildEnvelope(text, title);

  setEtchStatus("Collecting quotes from network…", "warn");
  const prepared = await invoke<PreparedPublicEtch>("prepare_public_etch", { data: Array.from(data) });
  const totalAtto = BigInt(prepared.total_amount);

  setEtchStatus("Checking ANT allowance…", "warn");
  const allowanceCalldata = erc20Iface.encodeFunctionData("allowance", [userAddress, VAULT_ADDRESS]);
  const allowanceHex = await ethCall(ANT_TOKEN_ADDRESS, allowanceCalldata);
  const allowance = BigInt(allowanceHex);
  const needsApproval = allowance < totalAtto;

  if (needsApproval) {
    setEtchStatus("Approve ANT in your wallet…", "warn");
    const approveAmount = SESSION_BUDGET_ATTO > totalAtto ? SESSION_BUDGET_ATTO : totalAtto;
    const approveCalldata = erc20Iface.encodeFunctionData("approve", [VAULT_ADDRESS, approveAmount]);
    const approveHash = await sendTx(walletProvider, userAddress, ANT_TOKEN_ADDRESS, approveCalldata, "approve ANT spend in your wallet");
    setEtchStatus(`Waiting for approve confirmation (${approveHash.slice(0, 10)}…)`, "warn");
    const approveReceipt = await rpc.waitForTransaction(approveHash);
    if (approveReceipt?.status !== 1) throw new Error(`ANT approve reverted (${approveHash})`);
  }

  setEtchStatus("Sign payment in your wallet…", "warn");
  const ensureHex = (s: string) => (s.startsWith("0x") || s.startsWith("0X") ? s : "0x" + s);
  const vaultPayments = prepared.payments.map((p) => [
    ensureHex(p.rewards_address),
    BigInt(p.amount),
    ensureHex(p.quote_hash),
  ]);
  const payCalldata = vaultIface.encodeFunctionData("payForQuotes", [vaultPayments]);
  const payHash = await sendTx(walletProvider, userAddress, VAULT_ADDRESS, payCalldata, "sign the etch payment in your wallet");
  setEtchStatus(`Waiting for payment confirmation (${payHash.slice(0, 10)}…)`, "warn");
  const payReceipt = await rpc.waitForTransaction(payHash);
  if (payReceipt?.status !== 1) throw new Error(`payForQuotes reverted (${payHash})`);

  setEtchStatus("Finalizing upload — pushing chunks to network…", "warn");
  const txHashes: Record<string, string> = {};
  for (const p of prepared.payments) txHashes[p.quote_hash] = payHash;
  return await invoke<PublicEtchResult>("finalize_public_etch", {
    uploadId: prepared.upload_id,
    txHashes,
  });
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
  addBtn.textContent = "Add to library";
  addBtn.onclick = async () => {
    addBtn.disabled = true;
    libStatus.style.color = "var(--ash)";
    try {
      if (!walletKeys) {
        // Derive on demand — same flow as Connect wallet, but without
        // running the full library decode after.
        libStatus.textContent = "Sign library-derive message in your wallet…";
        await connectAndDeriveKey();
      }
      libStatus.textContent = "Sign library update in your wallet…";
      const txHash = await addToLibrary(result.address, title || "");
      libStatus.style.color = "var(--copper)";
      libStatus.textContent = `Waiting for confirmation (${txHash.slice(0, 10)}…)`;
      const receipt = await rpc.waitForTransaction(txHash);
      if (receipt?.status === 1) {
        libStatus.style.color = "var(--green)";
        libStatus.textContent = `Added to library · ${txHash.slice(0, 10)}…`;
        addBtn.textContent = "Added";
      } else {
        libStatus.style.color = "var(--red)";
        libStatus.textContent = `Library update reverted (${txHash})`;
        addBtn.disabled = false;
      }
    } catch (e) {
      libStatus.style.color = "var(--red)";
      libStatus.textContent = `Library add failed: ${(e as Error).message ?? String(e)}`;
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

  // Storage key is needed to encrypt the data-map at rest. If not yet
  // derived, prompt for the dedicated private-storage personal_sign —
  // distinct from the library-derive sign so we don't conflate them.
  setEtchStatus("Sign private-storage message in your wallet (one-time)…", "warn");
  const { wallet: storageWallet, key: storageKey } = await ensureStorageKey();

  const data = buildEnvelope(text, title);

  setEtchStatus("Collecting quotes from network…", "warn");
  const prepared = await invoke<PreparedPrivateEtch>("prepare_private_etch", { data: Array.from(data) });
  const totalAtto = BigInt(prepared.total_amount);

  setEtchStatus("Checking ANT allowance…", "warn");
  const allowanceCalldata = erc20Iface.encodeFunctionData("allowance", [userAddress, VAULT_ADDRESS]);
  const allowance = BigInt(await ethCall(ANT_TOKEN_ADDRESS, allowanceCalldata));
  if (allowance < totalAtto) {
    setEtchStatus("Approve ANT in your wallet…", "warn");
    const approveAmount = SESSION_BUDGET_ATTO > totalAtto ? SESSION_BUDGET_ATTO : totalAtto;
    const approveCalldata = erc20Iface.encodeFunctionData("approve", [VAULT_ADDRESS, approveAmount]);
    const approveHash = await sendTx(walletProvider, userAddress, ANT_TOKEN_ADDRESS, approveCalldata, "approve ANT spend in your wallet");
    setEtchStatus(`Waiting for approve confirmation (${approveHash.slice(0, 10)}…)`, "warn");
    const r = await rpc.waitForTransaction(approveHash);
    if (r?.status !== 1) throw new Error(`ANT approve reverted (${approveHash})`);
  }

  setEtchStatus("Sign payment in your wallet…", "warn");
  const ensureHex = (s: string) => (s.startsWith("0x") || s.startsWith("0X") ? s : "0x" + s);
  const vaultPayments = prepared.payments.map((p) => [
    ensureHex(p.rewards_address),
    BigInt(p.amount),
    ensureHex(p.quote_hash),
  ]);
  const payCalldata = vaultIface.encodeFunctionData("payForQuotes", [vaultPayments]);
  const payHash = await sendTx(walletProvider, userAddress, VAULT_ADDRESS, payCalldata, "sign the etch payment in your wallet");
  setEtchStatus(`Waiting for payment confirmation (${payHash.slice(0, 10)}…)`, "warn");
  const r = await rpc.waitForTransaction(payHash);
  if (r?.status !== 1) throw new Error(`payForQuotes reverted (${payHash})`);

  setEtchStatus("Finalizing upload — pushing chunks to network…", "warn");
  const txHashes: Record<string, string> = {};
  for (const p of prepared.payments) txHashes[p.quote_hash] = payHash;
  const result = await invoke<PrivateEtchResult>("finalize_private_etch", {
    uploadId: prepared.upload_id,
    txHashes,
  });

  // Persist the data-map locally — encrypted with the wallet-derived
  // storage key. Without this map, the etch is unrecoverable.
  setEtchStatus("Saving data-map locally…", "warn");
  const id = newId();
  const cipher = await encryptDataMap(storageKey, prepared.data_map);
  const entries = loadPrivateEntries(storageWallet);
  entries.push({ id, title: title || "", ts: Math.floor(Date.now() / 1000), size: data.length, cipher });
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

$("etchBtn").addEventListener("click", async () => {
  const text = $<HTMLTextAreaElement>("etchText").value;
  const title = $<HTMLInputElement>("etchTitle").value.trim();
  const isPrivate = $<HTMLInputElement>("etchPrivate").checked;
  if (!text.trim()) { setEtchStatus("Content is empty.", "err"); return; }

  const btn = $<HTMLButtonElement>("etchBtn");
  btn.disabled = true;
  $("etchResult").innerHTML = "";
  try {
    if (isPrivate) {
      const r = await etchPrivate(text, title);
      setEtchStatus("Done.", "ok");
      showPrivateEtchResult(r.id, r.chunks, title);
      renderPrivateEtches();
    } else {
      const r = await etchPublic(text, title);
      setEtchStatus("Done.", "ok");
      showEtchResult(r, title);
    }
    void refreshAntBalance();
  } catch (e) {
    setEtchStatus(`Failed: ${(e as Error).message ?? String(e)}`, "err");
  } finally {
    btn.disabled = false;
  }
});

// ── Private etches list (Phase 3c) ───────────────────────────────

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
  sub.textContent = `id: ${id}${title ? ` · title: ${title}` : ""} · only this device can fetch it`;
  panel.appendChild(sub);

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
      const out = document.createElement("div");
      out.className = "fetch-result";
      out.textContent = "Fetching from network…";
      row.appendChild(out);
      try {
        const { data, title: t } = await fetchPrivateEntry(e.id);
        const detected = detectContent(data);
        out.innerHTML = "";
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
        appendError(out, `Fetch failed: ${(err as Error).message ?? String(err)}`);
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
