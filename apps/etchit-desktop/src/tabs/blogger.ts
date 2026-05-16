import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";

import type { ComposerHandle } from "../blog/composer";
import { mountComposer } from "../blog/composer";
import { mountTemplatePicker } from "../blog/templatePicker";
import type { BlogPalette, EditorState, Template } from "../blog/types";
import { historyAppendBestEffort } from "../history/store";
import { formatErr } from "../util/error";
import { mountActiveWalletBanner } from "../wallet/activeBanner";
import { uploadBytesViaWallet } from "../wallet/externalUpload";
import { loadWalletMode } from "../wallet/mode";

const SIZE_WARN_BYTES = 4 * 1024 * 1024;
const READ_WORDS_PER_MINUTE = 200;

interface TabState {
  status: "idle" | "etching";
  composer: ComposerHandle | null;
  template: Template | null;
}

/** Tracks the currently-attached document keydown listener so re-rendering
 *  the composer (or returning to the picker) doesn't leak handlers from
 *  the previous template's closure. */
let activeKeyHandler: ((e: KeyboardEvent) => void) | null = null;
let activeThemeObserver: MutationObserver | null = null;

function setActiveKeyHandler(h: ((e: KeyboardEvent) => void) | null): void {
  if (activeKeyHandler) {
    document.removeEventListener("keydown", activeKeyHandler);
  }
  activeKeyHandler = h;
  if (h) document.addEventListener("keydown", h);
}

function setActiveThemeObserver(obs: MutationObserver | null): void {
  if (activeThemeObserver) activeThemeObserver.disconnect();
  activeThemeObserver = obs;
}

/** The user's chosen app theme (`dark` / `dim` / `light`) maps onto two
 *  page palettes — light app posts publish light, anything else publishes
 *  dark. We track this live; if the user flips themes mid-compose, the
 *  canvas re-skins and the next preview/etch picks up the new palette. */
function currentPalette(): BlogPalette {
  return document.body.dataset.theme === "light" ? "light" : "dark";
}

export function mountBlogger(host: HTMLElement): void {
  host.innerHTML = `<div class="blog-tab"></div>`;
  const root = host.querySelector(".blog-tab") as HTMLElement;
  const state: TabState = { status: "idle", composer: null, template: null };

  const showPicker = (): void => {
    setActiveKeyHandler(null);
    setActiveThemeObserver(null);
    state.composer = null;
    state.template = null;
    renderPicker(root, (tmpl) => renderComposer(root, tmpl, state, showPicker));
  };
  showPicker();
}

function renderPicker(root: HTMLElement, onPick: (t: Template) => void): void {
  root.innerHTML = "";
  const host = document.createElement("div");
  host.className = "blog-pick";
  root.appendChild(host);
  mountTemplatePicker(host, onPick);
}

function renderComposer(
  root: HTMLElement,
  template: Template,
  state: TabState,
  onSwitch: () => void,
): void {
  root.innerHTML = `
    <header class="blog-edit-header">
      <div>
        <h1>${escapeAttr(template.name)}</h1>
        <p class="blog-edit-lede">${escapeAttr(template.description)}</p>
      </div>
      <button type="button" class="blog-edit-switch">Switch template</button>
    </header>

    <div class="blog-edit-canvas"></div>

    <div class="blog-edit-actions">
      <div class="blog-edit-meta">
        <p class="blog-edit-size">No images yet.</p>
        <p class="blog-edit-words"></p>
        <p class="wallet-active-banner blog-edit-wallet-banner"></p>
      </div>
      <div class="blog-edit-buttons">
        <button type="button" class="blog-edit-preview" disabled title="Preview (⌘P)">Preview</button>
        <button type="button" class="blog-edit-etch" disabled title="Etch (⌘↩)">Etch</button>
      </div>
    </div>

    <div class="blog-edit-preview-pane" hidden>
      <header class="blog-edit-preview-header">
        <h2>Preview &mdash; how readers will see this post</h2>
        <div class="blog-edit-preview-header-actions">
          <button type="button" class="blog-edit-preview-close">Back to edit</button>
          <button type="button" class="blog-edit-preview-etch">Etch</button>
        </div>
      </header>
      <iframe class="blog-edit-preview-frame" sandbox="allow-same-origin" title="Preview"></iframe>
    </div>

    <div class="blog-edit-result" hidden role="status" aria-live="polite"></div>
    <div class="blog-edit-error" hidden role="alert"></div>
  `;

  const canvas = root.querySelector(".blog-edit-canvas") as HTMLElement;
  const previewPane = root.querySelector(".blog-edit-preview-pane") as HTMLElement;
  const previewFrame = root.querySelector(".blog-edit-preview-frame") as HTMLIFrameElement;
  const previewCloseBtn = root.querySelector(".blog-edit-preview-close") as HTMLButtonElement;
  const previewEtchBtn = root.querySelector(".blog-edit-preview-etch") as HTMLButtonElement;
  const sizeEl = root.querySelector(".blog-edit-size") as HTMLElement;
  const wordsEl = root.querySelector(".blog-edit-words") as HTMLElement;
  const bannerEl = root.querySelector(".blog-edit-wallet-banner") as HTMLElement;
  mountActiveWalletBanner(bannerEl);
  const previewBtn = root.querySelector(".blog-edit-preview") as HTMLButtonElement;
  const etchBtn = root.querySelector(".blog-edit-etch") as HTMLButtonElement;
  const switchBtn = root.querySelector(".blog-edit-switch") as HTMLButtonElement;
  const resultEl = root.querySelector(".blog-edit-result") as HTMLElement;
  const errorEl = root.querySelector(".blog-edit-error") as HTMLElement;

  const applyPalette = (): void => {
    const p = currentPalette();
    canvas.dataset.palette = p;
    previewPane.dataset.palette = p;
  };
  applyPalette();
  const themeObs = new MutationObserver(applyPalette);
  themeObs.observe(document.body, { attributes: true, attributeFilter: ["data-theme"] });
  setActiveThemeObserver(themeObs);

  const composer = mountComposer(canvas, template);
  state.composer = composer;
  state.template = template;

  const refresh = (): void => {
    const bytes = composer.totalImageBytes();
    const ready = composer.isReady();
    sizeEl.textContent = bytes === 0
      ? "No images yet."
      : bytes > SIZE_WARN_BYTES
        ? `Total ${formatBytes(bytes)} of images — large posts take longer to publish.`
        : `Total ${formatBytes(bytes)} of images.`;
    sizeEl.dataset.tone = bytes > SIZE_WARN_BYTES ? "warn" : "muted";

    const words = composer.wordCount();
    if (words === 0) {
      wordsEl.textContent = "";
    } else {
      const minutes = Math.max(1, Math.round(words / READ_WORDS_PER_MINUTE));
      const w = words === 1 ? "word" : "words";
      wordsEl.textContent = `${words} ${w} · ${minutes} min read`;
    }

    if (state.status === "etching") {
      etchBtn.disabled = true;
      etchBtn.textContent = "Etching…";
      previewBtn.disabled = true;
    } else {
      etchBtn.textContent = "Etch";
      etchBtn.disabled = !ready;
      previewBtn.disabled = !ready;
    }
  };
  composer.onChange(refresh);
  refresh();

  const closePreview = (): void => {
    previewPane.hidden = true;
    document.body.classList.remove("blog-preview-open");
  };

  const openPreview = (): void => {
    if (!composer.isReady()) return;
    let html: string;
    try {
      html = template.serialize(composer.getState(), { palette: currentPalette() });
    } catch (e) {
      showError(errorEl, resultEl, formatErr(e));
      return;
    }
    previewFrame.srcdoc = html;
    previewPane.hidden = false;
    document.body.classList.add("blog-preview-open");
    resultEl.hidden = true;
    errorEl.hidden = true;
  };

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && !previewPane.hidden) {
      closePreview();
      return;
    }
    const meta = e.metaKey || e.ctrlKey;
    if (meta && (e.key === "p" || e.key === "P")) {
      e.preventDefault();
      if (previewPane.hidden && !previewBtn.disabled) openPreview();
      else if (!previewPane.hidden) closePreview();
      return;
    }
    if (meta && e.key === "Enter") {
      e.preventDefault();
      if (!etchBtn.disabled) doEtch();
    }
  };

  previewBtn.addEventListener("click", openPreview);
  previewCloseBtn.addEventListener("click", closePreview);
  setActiveKeyHandler(onKey);

  switchBtn.addEventListener("click", () => {
    void (async () => {
      if (state.composer && state.composer.totalImageBytes() === 0 && !state.composer.isReady()) {
        onSwitch();
        return;
      }
      const ok = await ask(
        "Switching templates discards what you've typed in this one. Continue?",
        { title: "Switch template", kind: "warning" },
      );
      if (ok) onSwitch();
    })();
  });

  const doEtch = (): void => {
    if (state.status === "etching" || !composer.isReady()) return;
    state.status = "etching";
    resultEl.hidden = true;
    errorEl.hidden = true;
    refresh();
    previewEtchBtn.disabled = true;
    previewEtchBtn.textContent = "Etching…";

    let html: string;
    try {
      html = template.serialize(composer.getState(), { palette: currentPalette() });
    } catch (e) {
      state.status = "idle";
      refresh();
      previewEtchBtn.disabled = false;
      previewEtchBtn.textContent = "Etch";
      showError(errorEl, resultEl, formatErr(e));
      return;
    }

    const onAddress = (address: string): void => {
      state.status = "idle";
      refresh();
      previewEtchBtn.disabled = false;
      previewEtchBtn.textContent = "Etch";
      closePreview();
      showResult(resultEl, errorEl, address);
      historyAppendBestEffort(address, blogLabel(composer.getState(), template), "blog");
    };
    const onFail = (e: unknown): void => {
      state.status = "idle";
      refresh();
      previewEtchBtn.disabled = false;
      previewEtchBtn.textContent = "Etch";
      showError(errorEl, resultEl, formatErr(e));
    };

    if (loadWalletMode() === "external") {
      const setStatus = (msg: string): void => {
        previewEtchBtn.textContent = msg;
        etchBtn.textContent = msg;
      };
      void uploadBytesViaWallet(new TextEncoder().encode(html), setStatus, {
        label: blogLabel(composer.getState(), template),
        historyKind: "blog",
      }).then(
        (r) => onAddress(r.address),
        onFail,
      );
      return;
    }

    void invoke<string>("etch_html", { html }).then(onAddress, onFail);
  };

  etchBtn.addEventListener("click", doEtch);
  previewEtchBtn.addEventListener("click", doEtch);
}

function showResult(resultEl: HTMLElement, errorEl: HTMLElement, address: string): void {
  errorEl.hidden = true;
  resultEl.hidden = false;
  resultEl.innerHTML = `
    <p class="blog-edit-result-headline">Etched.</p>
    <code class="blog-edit-result-addr"></code>
    <div class="blog-edit-result-actions">
      <button type="button" class="blog-edit-result-copy">Copy address</button>
      <button type="button" class="blog-edit-result-open">Open in fetch<span class="brand-mark">&gt;</span>it</button>
    </div>
  `;
  (resultEl.querySelector(".blog-edit-result-addr") as HTMLElement).textContent = address;
  (resultEl.querySelector(".blog-edit-result-copy") as HTMLButtonElement).addEventListener("click", () => {
    void navigator.clipboard.writeText(address).catch(() => {});
    const btn = resultEl.querySelector(".blog-edit-result-copy") as HTMLButtonElement;
    flash(btn, "Copied!");
  });
  (resultEl.querySelector(".blog-edit-result-open") as HTMLButtonElement).addEventListener("click", () => {
    void invoke("open_in_fetchit", { address }).catch((e: unknown) => {
      showError(errorEl, resultEl, formatErr(e));
    });
  });
}

function showError(errorEl: HTMLElement, resultEl: HTMLElement, msg: string): void {
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

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

// First text-kind slot is the conventional "title" across templates. Fall
// back to the template name if none is filled — keeps the History row
// readable even for image-led templates with no headline.
function blogLabel(state: EditorState, template: Template): string {
  for (const slot of template.slots) {
    if (slot.kind === "text" || slot.kind === "longtext") {
      const value = state.slots[slot.id];
      if (value && (value.kind === "text" || value.kind === "longtext") && value.value.trim()) {
        const line = value.value.trim().split("\n")[0]?.trim() ?? "";
        return line.length > 80 ? `${line.slice(0, 77)}…` : line;
      }
    }
  }
  return template.name;
}
