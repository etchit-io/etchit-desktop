import { invoke } from "@tauri-apps/api/core";

import { mountSiteComposer, type SiteComposerHandle } from "../website/composer";
import { mountSiteTemplatePicker } from "../website/templatePicker";
import type { BlogPalette } from "../blog/types";
import { historyAppendBestEffort } from "../history/store";
import type { SiteEditorState, SiteTemplate } from "../website/types";

const SIZE_WARN_BYTES = 4 * 1024 * 1024;
const READ_WORDS_PER_MINUTE = 200;

interface TabState {
  status: "idle" | "etching";
  composer: SiteComposerHandle | null;
  template: SiteTemplate | null;
}

let activeKeyHandler: ((e: KeyboardEvent) => void) | null = null;
let activeThemeObserver: MutationObserver | null = null;

function setActiveKeyHandler(h: ((e: KeyboardEvent) => void) | null): void {
  if (activeKeyHandler) document.removeEventListener("keydown", activeKeyHandler);
  activeKeyHandler = h;
  if (h) document.addEventListener("keydown", h);
}

function setActiveThemeObserver(obs: MutationObserver | null): void {
  if (activeThemeObserver) activeThemeObserver.disconnect();
  activeThemeObserver = obs;
}

function currentPalette(): BlogPalette {
  return document.body.dataset.theme === "light" ? "light" : "dark";
}

export function mountWebsite(host: HTMLElement): void {
  host.innerHTML = `<div class="site-tab"></div>`;
  const root = host.querySelector(".site-tab") as HTMLElement;
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

function renderPicker(root: HTMLElement, onPick: (t: SiteTemplate) => void): void {
  root.innerHTML = "";
  const host = document.createElement("div");
  host.className = "site-pick";
  root.appendChild(host);
  mountSiteTemplatePicker(host, onPick);
}

function renderComposer(
  root: HTMLElement,
  template: SiteTemplate,
  state: TabState,
  onSwitch: () => void,
): void {
  root.innerHTML = `
    <header class="site-edit-header">
      <div>
        <h1>${escapeAttr(template.name)}</h1>
        <p class="site-edit-lede">${escapeAttr(template.description)}</p>
      </div>
      <button type="button" class="site-edit-switch">Switch template</button>
    </header>

    <div class="site-edit-canvas"></div>

    <div class="site-edit-actions">
      <div class="site-edit-meta">
        <p class="site-edit-size">No images yet.</p>
        <p class="site-edit-words"></p>
        <p class="site-edit-missing" hidden></p>
      </div>
      <div class="site-edit-buttons">
        <button type="button" class="site-edit-preview" disabled title="Preview (⌘P)">Preview</button>
        <button type="button" class="site-edit-etch" disabled title="Etch (⌘↩)">Etch</button>
      </div>
    </div>

    <div class="site-edit-preview-pane" hidden>
      <header class="site-edit-preview-header">
        <h2>Preview &mdash; how readers will see this site</h2>
        <div class="site-edit-preview-header-actions">
          <button type="button" class="site-edit-preview-close">Back to edit</button>
          <button type="button" class="site-edit-preview-etch">Etch</button>
        </div>
      </header>
      <iframe class="site-edit-preview-frame" sandbox="allow-same-origin allow-scripts" title="Preview"></iframe>
    </div>

    <div class="site-edit-result" hidden role="status" aria-live="polite"></div>
    <div class="site-edit-error" hidden role="alert"></div>
  `;

  const canvas = root.querySelector(".site-edit-canvas") as HTMLElement;
  const previewPane = root.querySelector(".site-edit-preview-pane") as HTMLElement;
  const previewFrame = root.querySelector(".site-edit-preview-frame") as HTMLIFrameElement;
  const previewCloseBtn = root.querySelector(".site-edit-preview-close") as HTMLButtonElement;
  const previewEtchBtn = root.querySelector(".site-edit-preview-etch") as HTMLButtonElement;
  const sizeEl = root.querySelector(".site-edit-size") as HTMLElement;
  const wordsEl = root.querySelector(".site-edit-words") as HTMLElement;
  const missingEl = root.querySelector(".site-edit-missing") as HTMLElement;
  const previewBtn = root.querySelector(".site-edit-preview") as HTMLButtonElement;
  const etchBtn = root.querySelector(".site-edit-etch") as HTMLButtonElement;
  const switchBtn = root.querySelector(".site-edit-switch") as HTMLButtonElement;
  const resultEl = root.querySelector(".site-edit-result") as HTMLElement;
  const errorEl = root.querySelector(".site-edit-error") as HTMLElement;

  const applyPalette = (): void => {
    const p = currentPalette();
    canvas.dataset.palette = p;
    previewPane.dataset.palette = p;
  };
  applyPalette();
  const themeObs = new MutationObserver(applyPalette);
  themeObs.observe(document.body, { attributes: true, attributeFilter: ["data-theme"] });
  setActiveThemeObserver(themeObs);

  const composer = mountSiteComposer(canvas, template);
  state.composer = composer;
  state.template = template;

  const jumpToMissing = (): void => {
    const [first] = composer.missing();
    if (!first) return;
    if (first.pageId) composer.goToPage(first.pageId);
    const slotEl = canvas.querySelector(`[data-slot-id="${first.slotId}"]`) as HTMLElement | null;
    if (slotEl) {
      slotEl.scrollIntoView({ block: "center", behavior: "smooth" });
      const field = slotEl.querySelector("input, textarea") as HTMLInputElement | HTMLTextAreaElement | null;
      field?.focus({ preventScroll: true });
    }
  };

  const refresh = (): void => {
    const bytes = composer.totalImageBytes();
    const missingSlots = composer.missing();
    const ready = missingSlots.length === 0;
    sizeEl.textContent = bytes === 0
      ? "No images yet."
      : bytes > SIZE_WARN_BYTES
        ? `Total ${formatBytes(bytes)} of images — large sites take longer to publish.`
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

    if (ready) {
      missingEl.hidden = true;
      missingEl.textContent = "";
    } else {
      missingEl.hidden = false;
      missingEl.innerHTML = "";
      const total = missingSlots.length;
      const [first] = missingSlots;
      const lead = document.createElement("span");
      lead.textContent = total === 1 ? "Need: " : `Need ${total} more — start with: `;
      missingEl.appendChild(lead);
      const link = document.createElement("button");
      link.type = "button";
      link.className = "site-edit-missing-link";
      const label = first.pageId === null ? first.slotId : `${first.pageName} → ${first.slotId}`;
      link.textContent = label;
      link.addEventListener("click", jumpToMissing);
      missingEl.appendChild(link);
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
      showError(errorEl, resultEl, String(e));
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
    if (state.composer && state.composer.totalImageBytes() === 0 && !state.composer.isReady()) {
      onSwitch();
      return;
    }
    if (window.confirm("Switching templates discards what you've typed in this one. Continue?")) {
      onSwitch();
    }
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
      showError(errorEl, resultEl, String(e));
      return;
    }

    void invoke<string>("etch_html", { html }).then(
      (address) => {
        state.status = "idle";
        refresh();
        previewEtchBtn.disabled = false;
        previewEtchBtn.textContent = "Etch";
        closePreview();
        showResult(resultEl, errorEl, address);
        historyAppendBestEffort(address, siteLabel(composer.getState(), template), "site");
      },
      (e) => {
        state.status = "idle";
        refresh();
        previewEtchBtn.disabled = false;
        previewEtchBtn.textContent = "Etch";
        showError(errorEl, resultEl, String(e));
      },
    );
  };

  etchBtn.addEventListener("click", doEtch);
  previewEtchBtn.addEventListener("click", doEtch);
}

function showResult(resultEl: HTMLElement, errorEl: HTMLElement, address: string): void {
  errorEl.hidden = true;
  resultEl.hidden = false;
  resultEl.innerHTML = `
    <p class="site-edit-result-headline">Site etched.</p>
    <code class="site-edit-result-addr"></code>
    <div class="site-edit-result-actions">
      <button type="button" class="site-edit-result-copy">Copy address</button>
      <button type="button" class="site-edit-result-open">Open in fetch&gt;it</button>
    </div>
  `;
  (resultEl.querySelector(".site-edit-result-addr") as HTMLElement).textContent = address;
  (resultEl.querySelector(".site-edit-result-copy") as HTMLButtonElement).addEventListener("click", () => {
    void navigator.clipboard.writeText(address).catch(() => {});
    const btn = resultEl.querySelector(".site-edit-result-copy") as HTMLButtonElement;
    flash(btn, "Copied!");
  });
  (resultEl.querySelector(".site-edit-result-open") as HTMLButtonElement).addEventListener("click", () => {
    void invoke("open_in_fetchit", { address }).catch((e: unknown) => {
      showError(errorEl, resultEl, String(e));
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

// Prefer a site-level text slot (the conventional "siteName"). Falls
// back to the template name so image-led templates still get a row.
function siteLabel(state: SiteEditorState, template: SiteTemplate): string {
  for (const slot of template.siteSlots) {
    if (slot.kind === "text" || slot.kind === "longtext") {
      const value = state.site[slot.id];
      if (value && (value.kind === "text" || value.kind === "longtext") && value.value.trim()) {
        const line = value.value.trim().split("\n")[0]?.trim() ?? "";
        return line.length > 80 ? `${line.slice(0, 77)}…` : line;
      }
    }
  }
  return template.name;
}
