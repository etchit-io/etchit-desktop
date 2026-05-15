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
import { mountActiveWalletBanner } from "../wallet/activeBanner";
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
          <h2>Your private etches</h2>
          <p class="private-library-hint">Local to this device. Decrypt by tapping an entry.</p>
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
    submitEl.disabled =
      state.mode === "text" ? bodyEl.value.trim().length === 0 : state.picked.length === 0;
  };

  bodyEl.addEventListener("input", refreshSubmit);
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
        <button type="button" class="private-row-export" title="Copy data-map for backup">Export</button>
        <button type="button" class="private-row-delete" aria-label="Delete">×</button>
      </div>
      <pre class="private-row-content" hidden></pre>
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
    openBtn.textContent = kind === "file" ? "Save As…" : "Open";
    const content = li.querySelector(".private-row-content") as HTMLElement;

    if (state.expanded.has(entry.id) && kind === "text") {
      content.hidden = false;
      content.textContent = "Decrypting…";
      void decryptText(entry, content);
    }

    openBtn.addEventListener("click", () => {
      if (kind === "file") {
        void saveFile(entry, flashLibrary);
        return;
      }
      if (state.expanded.has(entry.id)) {
        state.expanded.delete(entry.id);
        content.hidden = true;
        return;
      }
      state.expanded.add(entry.id);
      content.hidden = false;
      content.textContent = "Decrypting…";
      void decryptText(entry, content);
    });

    (li.querySelector(".private-row-export") as HTMLButtonElement).addEventListener(
      "click",
      () => {
        void navigator.clipboard.writeText(entry.data_map).then(
          () => flashLibrary("Data-map copied. Keep it safe."),
          () => flashLibrary("Couldn't copy."),
        );
      },
    );
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

    if (state.mode === "text") {
      const body = bodyEl.value;
      const bodyBytes = new TextEncoder().encode(body);
      const localTitle = firstLine(body) || "Untitled";
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
            title: filename,
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
          title: filename,
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
    const entry: PrivateEntry = {
      id: newEntryId(),
      title: input.title,
      data_map: input.data_map,
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

async function decryptText(entry: PrivateEntry, el: HTMLElement): Promise<void> {
  try {
    const bytes = await fetchPrivateData(entry.data_map);
    const text = new TextDecoder().decode(bytes);
    // Old entries (pre-envelope-removal) shipped as
    // `{"v":1,"meta":{...},"content":"..."}`. Detect that shape
    // narrowly and surface only the content; otherwise show the
    // raw bytes, which is what we ship today.
    try {
      const parsed: unknown = JSON.parse(text);
      if (
        parsed && typeof parsed === "object" &&
        (parsed as { v?: unknown }).v === 1 &&
        "meta" in parsed &&
        "content" in parsed &&
        typeof (parsed as { content?: unknown }).content === "string"
      ) {
        el.textContent = (parsed as { content: string }).content;
        return;
      }
    } catch {
      // Not JSON — fall through.
    }
    el.textContent = text;
  } catch (e) {
    el.textContent = `Couldn't fetch: ${formatErr(e)}`;
  }
}

async function saveFile(
  entry: PrivateEntry,
  flash: (msg: string) => void,
): Promise<void> {
  try {
    flash("Decrypting…");
    const bytes = await fetchPrivateData(entry.data_map);
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

function firstLine(body: string): string {
  const line = body
    .split("\n")
    .map((s) => s.trim())
    .find((s) => s.length > 0) ?? "";
  return line.length > 80 ? `${line.slice(0, 77)}…` : line;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
