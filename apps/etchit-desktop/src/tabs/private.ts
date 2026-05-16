// Private tab — encrypted etches. The chunks live on Autonomi as
// opaque content-addressed blobs; only the locally-persisted
// data-map can decrypt them. Two payload kinds:
//
//   * text  — typed body, wrapped in the etch/it envelope. Decrypt
//             shows the content inline.
//   * file  — any file from disk. Decrypt offers Save As…
//
// Mode-aware: internal mode uses the cached wallet-bearing client
// (single-shot); external mode runs the wallet prepare → pay →
// finalize pipeline. Either way the data-map ends up in
// `private_etches.json` and the entry shows up in the library below.

import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";

import { relativeTime } from "../history/format";
import {
  PRIVATE_CHANGED_EVENT,
  type PrivateEntry,
  type PrivateKind,
  fetchPrivateData,
  newEntryId,
  privateAppend,
  privateDelete,
  privateLoad,
} from "../private/store";
import { bindFileDropZone } from "../util/dragDrop";
import { formatErr } from "../util/error";
import { backupDecrypt, backupEncrypt } from "../private/backup";
import { openBackupModal } from "../private/backupModal";
import { decryptBlob, encryptBlob } from "../private/cipherBlob";
import { openPasswordModal } from "../private/passwordModal";
import {
  currentPassword,
  loadStoredPassword,
  setSessionPassword,
} from "../private/passwordSession";
import { mountActiveWalletBanner } from "../wallet/activeBanner";
import { uploadBytesViaWallet } from "../wallet/externalUpload";
import {
  uploadPrivateFileViaWallet,
  uploadPrivateFilesViaWallet,
  uploadPrivateViaWallet,
} from "../wallet/externalPrivateUpload";
import { loadWalletMode } from "../wallet/mode";

interface InternalPrivateResult {
  data_map: string;
  chunks_stored: number;
}
interface InternalWalletInfo {
  address: string;
  ant_atto: string;
  eth_wei: string;
}

type Mode = "text" | "file";

interface PickedItem {
  path: string;
  label: string;
  size: number;
  isDir: boolean;
}

interface TabState {
  mode: Mode;
  status: "idle" | "etching";
  picked: PickedItem[];
  entries: PrivateEntry[];
  expanded: Set<string>;
}

export function mountPrivate(host: HTMLElement): void {
  // Structural classes mirror the Etch tab (`etch-*`) on purpose:
  // same page rhythm, same form widgets, same drop zone. The library
  // section below is Private-specific and keeps its own classes.
  host.innerHTML = `
    <div class="etch-tab private-tab">
      <header class="etch-header">
        <h1>Private Etch</h1>
        <p class="etch-lede">
          Encrypted etches. The data lives on Autonomi as opaque chunks;
          only this device's data-map can decrypt them. Lose the data-map
          and the upload is gone forever &mdash; export it if you care.
        </p>
      </header>

      <div class="etch-modes" role="tablist" aria-label="What to etch privately">
        <button type="button" class="etch-mode is-active" data-mode="text" role="tab" aria-selected="true">Text</button>
        <button type="button" class="etch-mode" data-mode="file" role="tab" aria-selected="false">File</button>
      </div>

      <div class="etch-title-row">
        <label class="etch-label" for="private-title">Title</label>
        <input id="private-title" class="etch-input" type="text" placeholder="label for your library on this device — never uploaded" maxlength="80" autocomplete="off" spellcheck="false">
      </div>

      <section class="etch-form" data-mode="text">
        <label class="etch-label" for="private-body">Body</label>
        <textarea id="private-body" class="etch-textarea" rows="14" placeholder="paste or type — encrypted before it touches the network"></textarea>
      </section>

      <section class="etch-form" data-mode="file" hidden>
        <div class="etch-drop">
          <p class="etch-drop-prompt">Drop files or a folder here, or click to pick. Multiple items get bundled into one ZIP archive (encrypted before upload).</p>
          <button type="button" class="etch-pick private-pick">Choose files…</button>
          <ul class="etch-picked-list" hidden></ul>
          <p class="etch-picked-summary" hidden></p>
        </div>
      </section>

      <p class="wallet-active-banner private-wallet-banner"></p>
      <button type="button" class="etch-submit private-submit" disabled>Etch privately</button>

      <div class="etch-result private-result" hidden role="status" aria-live="polite"></div>
      <div class="etch-error private-error" hidden role="alert"></div>

      <section class="private-library">
        <header class="private-library-header">
          <div>
            <h2>Your private etches</h2>
            <p class="private-library-hint">Local to this device. Decrypt by tapping an entry.</p>
          </div>
          <div class="private-library-actions">
            <button type="button" class="private-export-btn" title="Encrypt the whole library into a passphrase-protected backup file">Encrypt…</button>
            <button type="button" class="private-import-btn" title="Restore a passphrase-protected backup from another device">Import…</button>
          </div>
        </header>
        <p class="private-library-status" hidden role="status"></p>
        <div class="private-library-empty" hidden>
          <p>No private etches yet. The next one you etch will land here.</p>
        </div>
        <ul class="private-library-list" hidden></ul>
      </section>
    </div>
  `;

  const root = host.querySelector(".private-tab") as HTMLElement;
  const bodyEl = root.querySelector("#private-body") as HTMLTextAreaElement;
  const titleEl = root.querySelector("#private-title") as HTMLInputElement;
  const bannerEl = root.querySelector(".private-wallet-banner") as HTMLElement;
  const submitEl = root.querySelector(".private-submit") as HTMLButtonElement;
  const resultEl = root.querySelector(".private-result") as HTMLElement;
  const errorEl = root.querySelector(".private-error") as HTMLElement;
  const dropEl = root.querySelector(".etch-drop") as HTMLElement;
  const pickedListEl = root.querySelector(".etch-picked-list") as HTMLUListElement;
  const pickedSummaryEl = root.querySelector(".etch-picked-summary") as HTMLElement;
  const libraryEmpty = root.querySelector(".private-library-empty") as HTMLElement;
  const libraryList = root.querySelector(".private-library-list") as HTMLUListElement;
  const libraryStatus = root.querySelector(".private-library-status") as HTMLElement;

  mountActiveWalletBanner(bannerEl);

  const state: TabState = {
    mode: "text",
    status: "idle",
    picked: [],
    entries: [],
    expanded: new Set(),
  };

  const setMode = (m: Mode): void => {
    state.mode = m;
    for (const btn of root.querySelectorAll<HTMLButtonElement>(".etch-mode")) {
      const active = btn.dataset.mode === m;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
    }
    for (const form of root.querySelectorAll<HTMLElement>(".etch-form")) {
      form.hidden = form.dataset.mode !== m;
    }
    refreshSubmit();
  };

  const refreshSubmit = (): void => {
    if (state.status === "etching") {
      submitEl.disabled = true;
      submitEl.textContent = "Etching…";
      return;
    }
    submitEl.textContent = "Etch privately";
    const noTitle = titleEl.value.trim().length === 0;
    const noContent =
      state.mode === "text" ? bodyEl.value.trim().length === 0 : state.picked.length === 0;
    submitEl.disabled = noTitle || noContent;
  };

  bodyEl.addEventListener("input", refreshSubmit);
  titleEl.addEventListener("input", refreshSubmit);
  for (const btn of root.querySelectorAll<HTMLButtonElement>(".etch-mode")) {
    btn.addEventListener("click", () => setMode(btn.dataset.mode as Mode));
  }

  const renderPicked = (): void => {
    pickedListEl.innerHTML = "";
    pickedListEl.hidden = state.picked.length === 0;
    for (const [i, item] of state.picked.entries()) {
      const li = document.createElement("li");
      li.className = "etch-picked-chip";
      const name = document.createElement("span");
      name.className = "etch-picked-name";
      name.textContent = item.isDir ? `${item.label}/` : item.label;
      const meta = document.createElement("span");
      meta.className = "etch-picked-size";
      meta.textContent = item.isDir ? "folder" : formatBytes(item.size);
      const x = document.createElement("button");
      x.type = "button";
      x.className = "etch-picked-clear";
      x.setAttribute("aria-label", "Remove");
      x.title = "Remove";
      x.textContent = "×";
      x.addEventListener("click", () => removePicked(i));
      li.append(name, meta, x);
      pickedListEl.appendChild(li);
    }
    const willBundle = state.picked.length > 1 || (state.picked.length === 1 && state.picked[0].isDir);
    pickedSummaryEl.hidden = !willBundle;
    if (willBundle) {
      const rawTotal = state.picked.reduce((n, p) => n + p.size, 0);
      const label = state.picked.length === 1 ? "folder" : `${state.picked.length} items`;
      const baseSummary = `${label} · will be bundled as one encrypted ZIP · ${formatBytes(rawTotal)} raw, estimating zip size…`;
      pickedSummaryEl.textContent = baseSummary;
      void invoke<number>("estimate_zip_size_command", {
        paths: state.picked.map((p) => p.path),
      })
        .then((zipBytes) => {
          if (pickedSummaryEl.textContent !== baseSummary) return;
          pickedSummaryEl.textContent = `${label} · ${formatBytes(zipBytes)} ZIP (${formatBytes(rawTotal)} raw) — encrypted and bundled as one upload.`;
        })
        .catch(() => {
          pickedSummaryEl.textContent = `${label} · ${formatBytes(rawTotal)} raw — encrypted and bundled as one ZIP.`;
        });
    } else {
      pickedSummaryEl.textContent = "";
    }
    if (state.picked.length > 0 && titleEl.value.trim() === "") {
      const first = state.picked[0];
      titleEl.value = state.picked.length === 1
        ? first.isDir ? `${first.label}/` : first.label
        : `${state.picked.length} files`;
    }
    refreshSubmit();
  };

  const acceptPaths = async (paths: string[]): Promise<void> => {
    const existing = new Set(state.picked.map((p) => p.path));
    for (const p of paths) {
      if (existing.has(p)) continue;
      const [size, isDir] = await Promise.all([
        invoke<number>("file_size", { path: p }).catch(() => 0),
        invoke<boolean>("is_directory", { path: p }).catch(() => false),
      ]);
      state.picked.push({
        path: p,
        label: p.split(/[/\\]/).filter((s) => s.length > 0).pop() ?? p,
        size,
        isDir,
      });
    }
    renderPicked();
  };

  const removePicked = (index: number): void => {
    state.picked.splice(index, 1);
    renderPicked();
  };

  const clearPicked = (): void => {
    state.picked = [];
    renderPicked();
  };

  bindFileDropZone(dropEl, (paths) => {
    void acceptPaths(paths);
  });

  (root.querySelector(".private-pick") as HTMLButtonElement).addEventListener("click", () => {
    void openDialog({ multiple: true })
      .then((picked) => {
        if (picked === null) return;
        const paths = Array.isArray(picked) ? picked : [picked];
        void acceptPaths(paths.filter((p): p is string => typeof p === "string"));
      })
      .catch(() => {});
  });

  refreshSubmit();

  const flashLibrary = (msg: string): void => {
    libraryStatus.hidden = false;
    libraryStatus.textContent = msg;
    window.setTimeout(() => {
      libraryStatus.hidden = true;
    }, 1600);
  };

  const renderEntries = (): void => {
    const empty = state.entries.length === 0;
    libraryEmpty.hidden = !empty;
    libraryList.hidden = empty;
    libraryList.innerHTML = "";
    for (const entry of state.entries) libraryList.appendChild(rowFor(entry));
  };

  const rowFor = (entry: PrivateEntry): HTMLLIElement => {
    const kind: PrivateKind = entry.kind ?? "text";
    const li = document.createElement("li");
    li.className = "private-row";
    li.dataset.id = entry.id;
    li.innerHTML = `
      <div class="private-row-main">
        <p class="private-row-title"></p>
        <div class="private-row-meta">
          <span class="private-row-kind"></span>
          <span class="private-row-dot">·</span>
          <span class="private-row-mode"></span>
          <span class="private-row-dot">·</span>
          <span class="private-row-time"></span>
          <span class="private-row-dot">·</span>
          <span class="private-row-size"></span>
        </div>
      </div>
      <div class="private-row-actions">
        <button type="button" class="private-row-open"></button>
        <button type="button" class="private-row-save" hidden>Save As…</button>
        <button type="button" class="private-row-delete" aria-label="Delete">×</button>
      </div>
      <div class="private-row-content" hidden></div>
    `;
    (li.querySelector(".private-row-title") as HTMLElement).textContent =
      entry.title.trim() || "Untitled";
    (li.querySelector(".private-row-kind") as HTMLElement).textContent =
      kind === "file" ? "File" : "Text";
    (li.querySelector(".private-row-mode") as HTMLElement).textContent =
      entry.wallet_mode === "internal" ? "Internal" : "WalletConnect";
    (li.querySelector(".private-row-time") as HTMLElement).textContent = relativeTime(
      entry.ts_ms,
    );
    (li.querySelector(".private-row-size") as HTMLElement).textContent = formatBytes(
      entry.size_bytes,
    );

    const openBtn = li.querySelector(".private-row-open") as HTMLButtonElement;
    const saveBtn = li.querySelector(".private-row-save") as HTMLButtonElement;
    const content = li.querySelector(".private-row-content") as HTMLElement;

    // For files, the "open kind" depends on the original filename's
    // extension: images / audio / video / pdf can render inline via
    // blob URLs; everything else gets a Save As… button only so the
    // user can open it with their OS app of choice.
    const filename = entry.original_filename ?? entry.title;
    const previewKind: PreviewKind =
      kind === "text" ? "text" : detectPreviewKind(filename);

    if (previewKind === "binary") {
      // No inline preview possible — promote Save As… to the
      // primary action and hide the now-redundant secondary one.
      openBtn.textContent = "Save As…";
      saveBtn.hidden = true;
    } else {
      openBtn.textContent = "Open";
      saveBtn.hidden = kind !== "file"; // text entries don't need a save button
    }

    if (state.expanded.has(entry.id) && previewKind !== "binary") {
      content.hidden = false;
      content.textContent = "Decrypting…";
      void renderPreview(entry, content, previewKind);
    }

    openBtn.addEventListener("click", () => {
      if (previewKind === "binary") {
        void saveFile(entry, flashLibrary);
        return;
      }
      if (state.expanded.has(entry.id)) {
        state.expanded.delete(entry.id);
        content.hidden = true;
        content.replaceChildren();
        return;
      }
      state.expanded.add(entry.id);
      content.hidden = false;
      content.textContent = "Decrypting…";
      void renderPreview(entry, content, previewKind);
    });

    saveBtn.addEventListener("click", () => {
      void saveFile(entry, flashLibrary);
    });

    (li.querySelector(".private-row-delete") as HTMLButtonElement).addEventListener(
      "click",
      () => {
        if (
          !window.confirm(
            `Delete "${entry.title || "Untitled"}" from this device? The chunks stay on the network but you'll have no way to fetch them without the data-map.`,
          )
        ) {
          return;
        }
        void privateDelete(entry.id).then(
          (next) => {
            state.entries = next;
            state.expanded.delete(entry.id);
            renderEntries();
            flashLibrary("Removed.");
          },
          (e) => flashLibrary(`Couldn't delete: ${formatErr(e)}`),
        );
      },
    );
    return li;
  };

  const refreshEntries = (): void => {
    void privateLoad().then(
      (entries) => {
        state.entries = entries;
        renderEntries();
      },
      (e) => flashLibrary(`Couldn't load private etches: ${formatErr(e)}`),
    );
  };

  window.addEventListener(PRIVATE_CHANGED_EVENT, refreshEntries);
  refreshEntries();

  (root.querySelector(".private-export-btn") as HTMLButtonElement).addEventListener(
    "click",
    () => {
      void exportLibrary(state, flashLibrary);
    },
  );
  (root.querySelector(".private-import-btn") as HTMLButtonElement).addEventListener(
    "click",
    () => {
      void importLibrary(state, flashLibrary, refreshEntries);
    },
  );

  submitEl.addEventListener("click", () => {
    if (state.status === "etching") return;
    state.status = "etching";
    resultEl.hidden = true;
    errorEl.hidden = true;
    refreshSubmit();

    const setStatus = (msg: string): void => {
      submitEl.textContent = msg;
    };
    const fail = (msg: string): void => {
      state.status = "idle";
      refreshSubmit();
      errorEl.hidden = false;
      errorEl.textContent = msg;
    };

    const mode = loadWalletMode();

    const localTitle = titleEl.value.trim();
    if (state.mode === "text") {
      const body = bodyEl.value;
      const bodyBytes = new TextEncoder().encode(body);
      if (mode === "external") {
        void uploadPrivateViaWallet(bodyBytes, setStatus).then(
          (r) => {
            void persistAndShow({
              kind: "text",
              data_map: r.dataMap,
              wallet_mode: "external",
              wallet_address: r.walletAddress,
              chunks_stored: r.chunksStored,
              size_bytes: bodyBytes.length,
              title: localTitle,
            });
          },
          (e) => fail(formatErr(e)),
        );
        return;
      }
      setStatus("Encrypting + uploading via internal wallet…");
      void Promise.all([
        invoke<InternalPrivateResult>("private_etch_internal_text", { body }),
        invoke<InternalWalletInfo | null>("internal_wallet_info"),
      ]).then(
        ([result, info]) => {
          void persistAndShow({
            kind: "text",
            data_map: result.data_map,
            wallet_mode: "internal",
            wallet_address: info?.address ?? "",
            chunks_stored: result.chunks_stored,
            size_bytes: bodyBytes.length,
            title: localTitle,
          });
        },
        (e) => fail(formatErr(e)),
      );
      return;
    }

    // File mode. Single file → raw upload. Folder or 2+ paths →
    // ZIP-bundle upload (encrypted as a whole).
    const items = state.picked;
    if (items.length === 0) {
      fail("no files selected");
      return;
    }
    const isBundle = items.length > 1 || items[0].isDir;
    const totalSize = items.reduce((n, i) => n + i.size, 0);
    const filename = isBundle
      ? `${items.length === 1 ? items[0].label : `${items.length} files`}.zip`
      : items[0].label;

    if (mode === "external") {
      const promise = isBundle
        ? uploadPrivateFilesViaWallet(items.map((i) => i.path), setStatus)
        : uploadPrivateFileViaWallet(items[0].path, setStatus);
      void promise.then(
        (r) => {
          void persistAndShow({
            kind: "file",
            data_map: r.dataMap,
            wallet_mode: "external",
            wallet_address: r.walletAddress,
            chunks_stored: r.chunksStored,
            size_bytes: totalSize,
            title: localTitle,
            original_filename: filename,
          });
        },
        (e) => fail(formatErr(e)),
      );
      return;
    }
    setStatus("Encrypting + uploading via internal wallet…");
    const rustPromise: Promise<InternalPrivateResult> = isBundle
      ? invoke<InternalPrivateResult>("private_etch_internal_files", {
          paths: items.map((i) => i.path),
        })
      : invoke<InternalPrivateResult>("private_etch_internal_file", { path: items[0].path });
    void Promise.all([
      rustPromise,
      invoke<InternalWalletInfo | null>("internal_wallet_info"),
    ]).then(
      ([result, info]) => {
        void persistAndShow({
          kind: "file",
          data_map: result.data_map,
          wallet_mode: "internal",
          wallet_address: info?.address ?? "",
          chunks_stored: result.chunks_stored,
          size_bytes: totalSize,
          title: localTitle,
          original_filename: filename,
        });
      },
      (e) => fail(formatErr(e)),
    );
  });

  const persistAndShow = async (input: {
    kind: PrivateKind;
    data_map: string;
    wallet_mode: "internal" | "external";
    wallet_address: string;
    chunks_stored: number;
    size_bytes: number;
    title: string;
    original_filename?: string;
  }): Promise<void> => {
    // Password-encrypt the data-map and upload the blob to Autonomi
    // as a public etch. The address (P) is the entry's recovery
    // handle — anyone with P + the password can decrypt, regardless
    // of wallet. If something fails along the way we save with
    // plaintext `data_map` as a fallback so the etch isn't lost.
    let enc_data_map_addr: string | undefined;
    let fallbackDataMap = "";
    try {
      const password = await ensurePassword();
      if (!password) throw new Error("password required to encrypt private etch");
      const dataMapBytes = new TextEncoder().encode(input.data_map);
      const blob = await encryptBlob(dataMapBytes, password);
      enc_data_map_addr = await uploadPublicBlob(input.wallet_mode, blob);
    } catch (e) {
      fallbackDataMap = input.data_map;
      errorEl.hidden = false;
      errorEl.textContent = `Couldn't publish the encrypted data-map: ${formatErr(e)}. Saved with plaintext data-map locally; export to a backup file from below to recover.`;
    }

    const entry: PrivateEntry = {
      id: newEntryId(),
      title: input.title,
      data_map: fallbackDataMap,
      ...(enc_data_map_addr ? { enc_data_map_addr } : {}),
      size_bytes: input.size_bytes,
      wallet_mode: input.wallet_mode,
      wallet_address: input.wallet_address,
      chunks_stored: input.chunks_stored,
      ts_ms: Date.now(),
      kind: input.kind,
      ...(input.original_filename ? { original_filename: input.original_filename } : {}),
    };
    try {
      await privateAppend(entry);
    } catch (e) {
      state.status = "idle";
      refreshSubmit();
      errorEl.hidden = false;
      errorEl.textContent = `Etched, but couldn't save the data-map locally: ${formatErr(e)}. Export it now from below.`;
      return;
    }
    state.status = "idle";
    if (state.mode === "text") {
      bodyEl.value = "";
    } else {
      clearPicked();
    }
    titleEl.value = "";
    refreshSubmit();
    resultEl.hidden = false;
    resultEl.innerHTML = `
      <p class="etch-result-headline">Private etch saved</p>
      <p class="private-result-body">
        Stored ${entry.chunks_stored} chunk${entry.chunks_stored === 1 ? "" : "s"}.
        Find it in the library below.
      </p>
    `;
  };
}

/** Resolve the plaintext data-map for an entry. Prefers
 *  `cipher_data_map` (the new shape) and falls back to the legacy
 *  plaintext `data_map` field. Throws when the user cancels the
 *  password prompt, the address doesn't decrypt (wrong password or
 *  tampered network bytes), or the entry has neither shape. */
async function dataMapFor(entry: PrivateEntry): Promise<string> {
  // Entries written by an earlier wallet-sig encryption scheme carry
  // `cipher_data_map` (in the JSON) with no recovery path under the
  // new password-only model. Surface a clear message rather than
  // letting "no data-map" leak through.
  if ("cipher_data_map" in entry && (entry as { cipher_data_map?: unknown }).cipher_data_map) {
    throw new Error(
      "this entry was encrypted with a previous scheme that's no longer supported — re-etch to recover, or delete from the library",
    );
  }
  if (entry.enc_data_map_addr) {
    const password = await ensurePassword({ purpose: "open" });
    if (!password) throw new Error("password required to decrypt this entry");
    const blob = Uint8Array.from(
      await invoke<number[]>("fetch_public_bytes", { address: entry.enc_data_map_addr }),
    );
    const plaintext = await decryptBlob(blob, password);
    if (plaintext == null) {
      throw new Error(
        "couldn't decrypt — wrong password, or the network blob has been tampered with",
      );
    }
    return new TextDecoder().decode(plaintext);
  }
  if (entry.data_map) return entry.data_map;
  throw new Error("entry has no data-map");
}

/** Returns the session password — prompting via the modal once per
 *  session. Locks in via `setSessionPassword` only after the caller
 *  has confirmed it decrypts something (so wrong-password attempts
 *  don't poison the cache). For etch flows the password is brand
 *  new (no prior content to verify against); we trust the user's
 *  modal input and cache it immediately. */
async function ensurePassword(
  opts: { purpose?: "etch" | "open" } = {},
): Promise<string | null> {
  // Wait out the startup keychain hydrate before deciding to prompt.
  // Without this, an etch fired faster than the keychain read would
  // see an empty session and pop the create modal, overwriting the
  // stored passphrase and orphaning the rest of the library.
  await loadStoredPassword();
  const cached = currentPassword();
  if (cached) return cached;
  const mode = opts.purpose === "open" ? "enter" : "create";
  const entered = await openPasswordModal(mode);
  if (entered) setSessionPassword(entered);
  return entered;
}

/** Upload an encrypted-data-map blob as a public Autonomi etch.
 *  Branches on wallet mode the same way the public Etch tab does. */
async function uploadPublicBlob(
  walletMode: "internal" | "external",
  blob: Uint8Array,
): Promise<string> {
  if (walletMode === "external") {
    const r = await uploadBytesViaWallet(blob);
    return r.address;
  }
  return invoke<string>("etch_bytes", { data: Array.from(blob) });
}

type PreviewKind = "text" | "image" | "audio" | "video" | "pdf" | "binary";

/** Map a filename to the inline-preview strategy. "binary" means we
 *  can't render it in-app — caller offers Save As… instead. */
function detectPreviewKind(filename: string): PreviewKind {
  const ext = (filename.split(".").pop() ?? "").toLowerCase();
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"].includes(ext)) return "image";
  if (["mp3", "wav", "ogg", "opus", "flac", "m4a", "aac"].includes(ext)) return "audio";
  if (["mp4", "webm", "mov", "mkv"].includes(ext)) return "video";
  if (ext === "pdf") return "pdf";
  if (
    ["txt", "md", "json", "csv", "yaml", "yml", "toml", "ini", "log", "html",
      "htm", "css", "js", "ts", "tsx", "jsx", "rs", "py", "go", "java", "kt",
      "swift", "sh", "bash", "zsh", "c", "cpp", "h", "hpp", "xml"].includes(ext)
  ) {
    return "text";
  }
  return "binary";
}

/** Dispatch on `kind` to render the decrypted bytes inline. */
async function renderPreview(
  entry: PrivateEntry,
  el: HTMLElement,
  kind: PreviewKind,
): Promise<void> {
  el.replaceChildren();
  el.textContent = "Decrypting…";
  let bytes: Uint8Array;
  try {
    const dataMap = await dataMapFor(entry);
    bytes = await fetchPrivateData(dataMap);
  } catch (e) {
    el.textContent = `Couldn't fetch: ${formatErr(e)}`;
    return;
  }
  el.replaceChildren();
  switch (kind) {
    case "text": {
      const text = new TextDecoder().decode(bytes);
      const pre = document.createElement("pre");
      pre.className = "private-row-text";
      // Back-compat: old text etches were wrapped in an envelope
      // `{"v":1,"meta":{...},"content":"..."}`. Detect that narrow
      // shape and unwrap; otherwise show the raw text.
      try {
        const parsed: unknown = JSON.parse(text);
        if (
          parsed && typeof parsed === "object" &&
          (parsed as { v?: unknown }).v === 1 &&
          "meta" in parsed &&
          "content" in parsed &&
          typeof (parsed as { content?: unknown }).content === "string"
        ) {
          pre.textContent = (parsed as { content: string }).content;
          el.appendChild(pre);
          return;
        }
      } catch {
        // not JSON — fall through.
      }
      pre.textContent = text;
      el.appendChild(pre);
      return;
    }
    case "image":
    case "audio":
    case "video": {
      const tag = kind === "image" ? "img" : kind;
      const node = document.createElement(tag) as HTMLImageElement | HTMLMediaElement;
      node.className = `private-row-${kind}`;
      if (kind !== "image") (node as HTMLMediaElement).controls = true;
      const blob = new Blob([bytes], { type: mimeFor(entry.original_filename ?? entry.title, kind) });
      const url = URL.createObjectURL(blob);
      node.src = url;
      // Revoke once loaded so we don't leak.
      const revoke = (): void => URL.revokeObjectURL(url);
      node.addEventListener("load", revoke, { once: true });
      node.addEventListener("error", revoke, { once: true });
      if (kind !== "image") {
        node.addEventListener("loadeddata", revoke, { once: true });
      }
      el.appendChild(node);
      return;
    }
    case "pdf": {
      const iframe = document.createElement("iframe");
      iframe.className = "private-row-pdf";
      iframe.setAttribute("sandbox", "");
      const blob = new Blob([bytes], { type: "application/pdf" });
      iframe.src = URL.createObjectURL(blob);
      el.appendChild(iframe);
      return;
    }
    case "binary":
      // Shouldn't reach here — caller routes binary through Save As…
      el.textContent = "Binary content. Use Save As… to write to disk.";
      return;
  }
}

function mimeFor(filename: string, kind: PreviewKind): string {
  const ext = (filename.split(".").pop() ?? "").toLowerCase();
  switch (ext) {
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "gif": return "image/gif";
    case "webp": return "image/webp";
    case "svg": return "image/svg+xml";
    case "mp3": return "audio/mpeg";
    case "wav": return "audio/wav";
    case "ogg":
    case "opus": return "audio/ogg";
    case "flac": return "audio/flac";
    case "m4a":
    case "aac": return "audio/aac";
    case "mp4": return "video/mp4";
    case "webm": return "video/webm";
    case "mov": return "video/quicktime";
    case "pdf": return "application/pdf";
    default: return `${kind}/*`;
  }
}

async function saveFile(
  entry: PrivateEntry,
  flash: (msg: string) => void,
): Promise<void> {
  try {
    flash("Decrypting…");
    const dataMap = await dataMapFor(entry);
    const bytes = await fetchPrivateData(dataMap);
    const dest = await saveDialog({
      defaultPath: entry.original_filename ?? entry.title,
      title: "Save decrypted file",
    });
    if (typeof dest !== "string") {
      flash("Cancelled.");
      return;
    }
    await invoke("save_bytes_to_path", { path: dest, data: Array.from(bytes) });
    flash(`Saved to ${dest}`);
  } catch (e) {
    flash(`Couldn't save: ${formatErr(e)}`);
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

// ── Export / Import ────────────────────────────────────────────────

async function exportLibrary(
  state: { entries: PrivateEntry[] },
  flash: (msg: string) => void,
): Promise<void> {
  if (state.entries.length === 0) {
    flash("Nothing to export — library is empty.");
    return;
  }
  const password = await openBackupModal("create");
  if (!password) return;

  flash("Encrypting…");
  // The payload is the entries JSON verbatim. Each entry already
  // carries `cipher_data_map` (wallet-key encrypted), so the
  // password-encrypted file wraps already-encrypted blobs — both
  // factors required to recover content on another device.
  const payload = new TextEncoder().encode(
    JSON.stringify({ v: 1, entries: state.entries }),
  );
  let bytes: Uint8Array;
  try {
    bytes = await backupEncrypt(payload, password);
  } catch (e) {
    flash(`Encrypt failed: ${formatErr(e)}`);
    return;
  }

  const dest = await saveDialog({
    defaultPath: `etchit-private-backup-${new Date().toISOString().slice(0, 10)}.etchitbackup`,
    title: "Save private library backup",
    filters: [{ name: "etchit backup", extensions: ["etchitbackup"] }],
  });
  if (typeof dest !== "string") {
    flash("Cancelled.");
    return;
  }
  try {
    await invoke("save_bytes_to_path", { path: dest, data: Array.from(bytes) });
    flash(`Backup saved to ${dest}. Keep the passphrase safe.`);
  } catch (e) {
    flash(`Couldn't save: ${formatErr(e)}`);
  }
}

async function importLibrary(
  state: { entries: PrivateEntry[] },
  flash: (msg: string) => void,
  refresh: () => void,
): Promise<void> {
  const picked = await openDialog({
    multiple: false,
    filters: [{ name: "etchit backup", extensions: ["etchitbackup"] }],
  });
  if (typeof picked !== "string") return;

  let bytes: Uint8Array;
  try {
    const arr = await invoke<number[]>("read_file_bytes", { path: picked });
    bytes = Uint8Array.from(arr);
  } catch (e) {
    flash(`Couldn't read backup: ${formatErr(e)}`);
    return;
  }

  const password = await openBackupModal("enter");
  if (!password) return;

  flash("Decrypting…");
  const plain = await backupDecrypt(bytes, password);
  if (!plain) {
    flash("Wrong passphrase, or this isn't an etchit backup file.");
    return;
  }

  let parsed: { entries?: unknown };
  try {
    parsed = JSON.parse(new TextDecoder().decode(plain)) as { entries?: unknown };
  } catch (e) {
    flash(`Backup file is malformed: ${formatErr(e)}`);
    return;
  }
  if (!Array.isArray(parsed.entries)) {
    flash("Backup file is malformed: no entries array.");
    return;
  }

  let added = 0;
  let skipped = 0;
  const existing = new Set(state.entries.map((e) => e.id));
  for (const e of parsed.entries as PrivateEntry[]) {
    if (!e.id || existing.has(e.id)) {
      skipped++;
      continue;
    }
    try {
      await privateAppend(e);
      added++;
      existing.add(e.id);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[private] import skip", e.id, err);
      skipped++;
    }
  }
  flash(`Imported ${added} entr${added === 1 ? "y" : "ies"}${skipped ? ` (skipped ${skipped})` : ""}.`);
  refresh();
}
