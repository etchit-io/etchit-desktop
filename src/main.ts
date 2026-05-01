// etchit library viewer — desktop frontend (Phase 1)
//
// Mirrors tools/library.html in the etchit-android-v3 repo, ported to
// TypeScript + Vite. Read-only: decrypts on-chain library entries and
// renders them. Phase 2 will replace ant-cli copy actions with in-app
// fetch via FFI calls into Rust.

const VERSION_BYTE = 0x01;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const BUCKETS = [1024, 4096, 16384] as const;
const RECIPIENT_PREFIX = new TextEncoder().encode("etchit-library-v1/recipient");

// Spec §4.1 — byte-exact (137 bytes UTF-8). Same string the mobile app signs.
const SIGN_MESSAGE =
  "etchit library v1\n\n" +
  "Sign this message to derive your encrypted-library key. " +
  "This signature does NOT authorize any transaction or transfer.";

// Spec §4.3 — HKDF info string for the AEAD key derivation.
const HKDF_INFO = new TextEncoder().encode("etchit-library/v1/aead-key");

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

type EthereumProvider = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
};

declare global {
  interface Window {
    ethereum?: EthereumProvider;
  }
}

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

async function deriveLibraryKey(signatureHex: string): Promise<Uint8Array> {
  // signatureHex is 0x-prefixed (r||s||v), 65 bytes total. Spec uses (r||s) as IKM.
  const sigBytes = hexToBytes(signatureHex);
  if (sigBytes.length !== 65) throw new Error(`unexpected sig length ${sigBytes.length}`);
  const ikm = sigBytes.slice(0, 64);
  const ikmKey = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: HKDF_INFO },
    ikmKey,
    256,
  );
  return new Uint8Array(bits);
}

// ── EIP-1193 wallet flow ─────────────────────────────────────────

async function connectAndDeriveKey(): Promise<{ wallet: string; key: Uint8Array }> {
  if (!window.ethereum) {
    throw new Error("No browser wallet detected. Use the manual key entry below.");
  }
  const accounts = await window.ethereum.request({ method: "eth_requestAccounts" }) as string[];
  if (!accounts || !accounts.length) throw new Error("Wallet returned no accounts.");
  const wallet = accounts[0];
  const messageHex = "0x" + bytesToHex(new TextEncoder().encode(SIGN_MESSAGE));
  const sigHex = await window.ethereum.request({
    method: "personal_sign",
    params: [messageHex, wallet],
  }) as string;
  const key = await deriveLibraryKey(sigHex);
  return { wallet, key };
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

    const copyCmd = document.createElement("button");
    copyCmd.className = "outlined";
    copyCmd.textContent = "Copy ant command";
    copyCmd.onclick = () => {
      const safe = (e.title || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 50) || e.addr.slice(0, 10);
      navigator.clipboard.writeText(`ant file download --output ${safe} ${e.addr}`);
      setStatus("status", "Command copied", "ok");
    };
    actions.appendChild(copyCmd);

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

// Tauri webviews don't ship with browser-extension wallets; users will
// fall through to manual entry until Phase 2 adds Reown AppKit Web.
if (!window.ethereum) {
  setStatus("connectStatus", "No browser wallet detected — expand the manual entry section below.", "err");
  $<HTMLButtonElement>("connect").disabled = true;
}
