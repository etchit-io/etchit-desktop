// etchit desktop frontend.
//
// Library viewer ported from tools/library.html in etchit-android-v3.
// Phase 2 wires the Tauri Rust backend (ant-ffi) so content can be
// fetched in-app instead of shelling out to ant-cli.

import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";

// Tauri v2 with withGlobalTauri=true exposes window.__TAURI__. Either of
// __TAURI_INTERNALS__ or __TAURI__ being present means we're inside the
// desktop webview vs. running in a plain browser dev session.
const inTauri =
  typeof (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== "undefined" ||
  typeof (window as unknown as { __TAURI__?: unknown }).__TAURI__ !== "undefined";

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

// Tauri webviews don't ship with browser-extension wallets; users will
// fall through to manual entry until Phase 2 adds Reown AppKit Web.
if (!window.ethereum) {
  setStatus("connectStatus", "No browser wallet detected — expand the manual entry section below.", "err");
  $<HTMLButtonElement>("connect").disabled = true;
}

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
