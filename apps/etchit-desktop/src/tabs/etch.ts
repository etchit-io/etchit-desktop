import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

import { historyAppendBestEffort } from "../history/store";
import { mountActiveWalletBanner } from "../wallet/activeBanner";
import { uploadFileViaWallet, uploadTextViaWallet } from "../wallet/externalUpload";
import { loadWalletMode } from "../wallet/mode";

type Mode = "text" | "file";

interface State {
  mode: Mode;
  pickedPath: string | null;
  pickedLabel: string | null;
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
        <label class="etch-label" for="etch-title">Title <span class="etch-hint">(optional)</span></label>
        <input id="etch-title" type="text" class="etch-input" placeholder="e.g. notes from a walk" spellcheck="false" />

        <label class="etch-label" for="etch-body">Body</label>
        <textarea id="etch-body" class="etch-textarea" rows="14" placeholder="paste or type — markdown is fine, fetch>it renders prose with the title in a header bar"></textarea>
      </section>

      <section class="etch-form" data-mode="file" hidden>
        <div class="etch-drop">
          <p class="etch-drop-prompt">Pick any file — image, audio, video, PDF, EPUB, ZIP, whatever.</p>
          <button type="button" class="etch-pick">Choose file…</button>
          <p class="etch-picked" hidden></p>
        </div>
      </section>

      <p class="wallet-active-banner etch-wallet-banner"></p>
      <button type="button" class="etch-submit" disabled>Etch</button>

      <div class="etch-result" hidden role="status" aria-live="polite"></div>
      <div class="etch-error" hidden role="alert"></div>
    </div>
  `;

  const state: State = { mode: "text", pickedPath: null, pickedLabel: null, status: "idle" };

  const $ = <T extends HTMLElement>(sel: string): T => host.querySelector(sel) as T;

  const titleEl = $<HTMLInputElement>("#etch-title");
  const bodyEl = $<HTMLTextAreaElement>("#etch-body");
  const pickedEl = $<HTMLParagraphElement>(".etch-picked");
  const bannerEl = $<HTMLParagraphElement>(".etch-wallet-banner");
  const submitEl = $<HTMLButtonElement>(".etch-submit");
  const resultEl = $<HTMLDivElement>(".etch-result");
  const errorEl = $<HTMLDivElement>(".etch-error");

  mountActiveWalletBanner(bannerEl);

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
      : state.pickedPath === null;
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
        showError(String(e));
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
    void openDialog({ multiple: false }).then((picked) => {
      if (typeof picked !== "string") return;
      state.pickedPath = picked;
      state.pickedLabel = picked.split(/[/\\]/).pop() ?? picked;
      pickedEl.hidden = false;
      pickedEl.textContent = state.pickedLabel;
      refreshSubmit();
    }).catch(() => {});
  });

  submitEl.addEventListener("click", () => {
    if (state.status === "etching") return;
    state.status = "etching";
    resultEl.hidden = true;
    errorEl.hidden = true;
    refreshSubmit();

    const done = (address: string): void => {
      state.status = "idle";
      refreshSubmit();
      showResult(address);
      if (state.mode === "text") {
        const label = titleEl.value.trim() || firstLine(bodyEl.value) || "Untitled text";
        historyAppendBestEffort(address, label, "text");
      } else {
        historyAppendBestEffort(address, state.pickedLabel ?? "File", "file");
      }
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

    if (walletMode === "external") {
      if (state.mode === "text") {
        void uploadTextViaWallet(titleEl.value, bodyEl.value, setStatus).then(
          (r) => done(r.address),
          (e) => fail(String(e)),
        );
      } else if (state.pickedPath) {
        void uploadFileViaWallet(state.pickedPath, setStatus).then(
          (r) => done(r.address),
          (e) => fail(String(e)),
        );
      } else {
        fail("no file selected");
      }
      return;
    }

    if (state.mode === "text") {
      void invoke<string>("etch_text", { title: titleEl.value, body: bodyEl.value }).then(done, (e) => fail(String(e)));
    } else if (state.pickedPath) {
      void invoke<string>("etch_file", { path: state.pickedPath }).then(done, (e) => fail(String(e)));
    } else {
      fail("no file selected");
    }
  });
}

function firstLine(body: string): string {
  const line = body.split("\n").map((s) => s.trim()).find((s) => s.length > 0) ?? "";
  return line.length > 80 ? `${line.slice(0, 77)}…` : line;
}
