import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

import { historyAppendBestEffort } from "../history/store";
import { bindFileDropZone } from "../util/dragDrop";
import { formatErr } from "../util/error";
import { mountActiveWalletBanner } from "../wallet/activeBanner";
import {
  uploadFilesViaWallet,
  uploadFileViaWallet,
  uploadTextViaWallet,
} from "../wallet/externalUpload";
import { loadWalletMode } from "../wallet/mode";

type Mode = "text" | "file";

interface PickedItem {
  path: string;
  label: string;
  size: number;
  isDir: boolean;
}

interface State {
  mode: Mode;
  picked: PickedItem[];
  status: "idle" | "etching";
}

export function mountEtch(host: HTMLElement): void {
  host.innerHTML = `
    <div class="etch-tab">
      <header class="etch-header">
        <h1>Etch</h1>
        <p class="etch-lede">
          Publish to Autonomi. Reads are free; etches cost a small amount of ANT.
          Uploads are neutral — only your content goes to the network.
        </p>
      </header>

      <div class="etch-modes" role="tablist" aria-label="What to etch">
        <button type="button" class="etch-mode is-active" data-mode="text" role="tab" aria-selected="true">Text</button>
        <button type="button" class="etch-mode" data-mode="file" role="tab" aria-selected="false">File</button>
      </div>

      <section class="etch-form" data-mode="text">
        <label class="etch-label" for="etch-body">Body</label>
        <textarea id="etch-body" class="etch-textarea" rows="14" placeholder="paste or type — exactly what you write is what lands on the network"></textarea>
      </section>

      <section class="etch-form" data-mode="file" hidden>
        <div class="etch-drop">
          <p class="etch-drop-prompt">Drop files or a folder here, or click to pick. Multiple files get bundled into one ZIP archive.</p>
          <button type="button" class="etch-pick">Choose files…</button>
          <ul class="etch-picked-list" hidden></ul>
          <p class="etch-picked-summary" hidden></p>
        </div>
      </section>

      <p class="wallet-active-banner etch-wallet-banner"></p>
      <button type="button" class="etch-submit" disabled>Etch</button>

      <div class="etch-result" hidden role="status" aria-live="polite"></div>
      <div class="etch-error" hidden role="alert"></div>
    </div>
  `;

  const state: State = { mode: "text", picked: [], status: "idle" };

  const $ = <T extends HTMLElement>(sel: string): T => host.querySelector(sel) as T;

  const bodyEl = $<HTMLTextAreaElement>("#etch-body");
  const dropEl = $<HTMLDivElement>(".etch-drop");
  const pickedListEl = $<HTMLUListElement>(".etch-picked-list");
  const pickedSummaryEl = $<HTMLParagraphElement>(".etch-picked-summary");
  const bannerEl = $<HTMLParagraphElement>(".etch-wallet-banner");
  const submitEl = $<HTMLButtonElement>(".etch-submit");
  const resultEl = $<HTMLDivElement>(".etch-result");
  const errorEl = $<HTMLDivElement>(".etch-error");

  mountActiveWalletBanner(bannerEl);

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
      const baseSummary = `${label} · will be bundled as one ZIP · ${formatBytes(rawTotal)} raw, estimating zip size…`;
      pickedSummaryEl.textContent = baseSummary;
      // Resolve the precise zip size in the background; rawTotal is
      // the floor (zipped archive is always ≥ data).
      void invoke<number>("estimate_zip_size_command", {
        paths: state.picked.map((p) => p.path),
      })
        .then((zipBytes) => {
          // Render only if the same picked set is still showing.
          if (pickedSummaryEl.textContent !== baseSummary) return;
          pickedSummaryEl.textContent = `${label} · ${formatBytes(zipBytes)} ZIP (${formatBytes(rawTotal)} raw) — bundled as one upload.`;
        })
        .catch(() => {
          pickedSummaryEl.textContent = `${label} · ${formatBytes(rawTotal)} raw — bundled as one ZIP.`;
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

  bindFileDropZone(dropEl, (paths) => {
    void acceptPaths(paths);
  });

  function setMode(m: Mode): void {
    state.mode = m;
    for (const btn of host.querySelectorAll<HTMLButtonElement>(".etch-mode")) {
      const active = btn.dataset.mode === m;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
    }
    for (const form of host.querySelectorAll<HTMLElement>(".etch-form")) {
      form.hidden = form.dataset.mode !== m;
    }
    refreshSubmit();
  }

  function refreshSubmit(): void {
    if (state.status === "etching") {
      submitEl.disabled = true;
      submitEl.textContent = "Etching…";
      return;
    }
    submitEl.textContent = "Etch";
    submitEl.disabled = state.mode === "text"
      ? bodyEl.value.trim().length === 0
      : state.picked.length === 0;
  }

  function showResult(address: string): void {
    errorEl.hidden = true;
    resultEl.hidden = false;
    resultEl.innerHTML = `
      <p class="etch-result-headline">Etched.</p>
      <code class="etch-result-addr"></code>
      <div class="etch-result-actions">
        <button type="button" class="etch-result-copy">Copy address</button>
        <button type="button" class="etch-result-open">Open in fetch&gt;it</button>
      </div>
    `;
    (resultEl.querySelector(".etch-result-addr") as HTMLElement).textContent = address;
    (resultEl.querySelector(".etch-result-copy") as HTMLButtonElement).addEventListener("click", () => {
      void navigator.clipboard.writeText(address).catch(() => {});
      flash(resultEl.querySelector(".etch-result-copy") as HTMLButtonElement, "Copied!");
    });
    (resultEl.querySelector(".etch-result-open") as HTMLButtonElement).addEventListener("click", () => {
      void invoke("open_in_fetchit", { address }).catch((e: unknown) => {
        showError(formatErr(e));
      });
    });
  }

  function showError(msg: string): void {
    resultEl.hidden = true;
    errorEl.hidden = false;
    errorEl.textContent = msg;
  }

  function flash(btn: HTMLButtonElement, msg: string): void {
    const original = btn.textContent ?? "";
    btn.textContent = msg;
    btn.disabled = true;
    window.setTimeout(() => {
      btn.textContent = original;
      btn.disabled = false;
    }, 1100);
  }

  // ── wire-up ─────────────────────────────────────────────────────────

  for (const btn of host.querySelectorAll<HTMLButtonElement>(".etch-mode")) {
    btn.addEventListener("click", () => setMode(btn.dataset.mode as Mode));
  }

  bodyEl.addEventListener("input", refreshSubmit);

  ($<HTMLButtonElement>(".etch-pick")).addEventListener("click", () => {
    void openDialog({ multiple: true })
      .then((picked) => {
        if (picked === null) return;
        const paths = Array.isArray(picked) ? picked : [picked];
        void acceptPaths(paths.filter((p): p is string => typeof p === "string"));
      })
      .catch(() => {});
  });

  submitEl.addEventListener("click", () => {
    if (state.status === "etching") return;
    state.status = "etching";
    resultEl.hidden = true;
    errorEl.hidden = true;
    refreshSubmit();

    const done = (address: string): void => {
      state.status = "idle";
      let label: string;
      if (state.mode === "text") {
        label = firstLine(bodyEl.value) || "Untitled text";
        historyAppendBestEffort(address, label, "text");
        bodyEl.value = "";
      } else {
        label = fileLabel(state.picked);
        historyAppendBestEffort(address, label, "file");
        state.picked = [];
        renderPicked();
      }
      refreshSubmit();
      showResult(address);
    };
    const fail = (msg: string): void => {
      state.status = "idle";
      refreshSubmit();
      showError(msg);
    };

    const walletMode = loadWalletMode();
    const setStatus = (msg: string): void => {
      submitEl.textContent = msg;
    };

    if (state.mode === "text") {
      if (walletMode === "external") {
        void uploadTextViaWallet(bodyEl.value, setStatus).then(
          (r) => done(r.address),
          (e) => fail(formatErr(e)),
        );
      } else {
        void invoke<string>("etch_text", { body: bodyEl.value }).then(done, (e) => fail(formatErr(e)));
      }
      return;
    }

    // File mode. Single file → raw upload (byte-identical). One folder
    // or ≥2 paths → zip-bundle (one upload, one address).
    const items = state.picked;
    if (items.length === 0) {
      fail("no files selected");
      return;
    }
    const isBundle = items.length > 1 || items[0].isDir;

    if (walletMode === "external") {
      if (isBundle) {
        void uploadFilesViaWallet(items.map((i) => i.path), setStatus).then(
          (r) => done(r.address),
          (e) => fail(formatErr(e)),
        );
      } else {
        void uploadFileViaWallet(items[0].path, setStatus).then(
          (r) => done(r.address),
          (e) => fail(formatErr(e)),
        );
      }
      return;
    }

    if (isBundle) {
      void invoke<string>("etch_files", { paths: items.map((i) => i.path) }).then(
        done,
        (e) => fail(formatErr(e)),
      );
    } else {
      void invoke<string>("etch_file", { path: items[0].path }).then(done, (e) => fail(formatErr(e)));
    }
  });
}

function firstLine(body: string): string {
  const line = body.split("\n").map((s) => s.trim()).find((s) => s.length > 0) ?? "";
  return line.length > 80 ? `${line.slice(0, 77)}…` : line;
}

function fileLabel(picked: PickedItem[]): string {
  if (picked.length === 0) return "File";
  if (picked.length === 1) return picked[0].isDir ? `${picked[0].label}/` : picked[0].label;
  return `${picked.length} files`;
}

function formatBytes(n: number): string {
  if (n === 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
