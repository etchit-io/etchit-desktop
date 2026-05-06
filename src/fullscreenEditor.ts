// Fullscreen text editor overlay — mirrors the mobile premium editor.
//
// Built around the classic "transparent textarea over highlighted <pre>"
// trick: the textarea handles all input, cursor, and selection; a <pre>
// behind it shows the syntax-highlighted version of the same content.
// scroll positions are synced so the two stay aligned.
//
// On Plain language: text wraps, no line-number gutter, prose-friendly.
// On any code language: wrap is disabled, gutter shows source-line numbers,
// horizontal scroll where needed — code-friendly.

import { LANGUAGES, highlightAs, detectLanguage } from "./syntaxHighlight";

export type FullscreenEditorOpts = {
  initialText: string;
  editable: boolean;
  title?: string;
  /** Override the auto-detected language. Lets a caller carry an
   *  inline-picked syntax over when opening fullscreen. */
  initialLanguage?: string;
  onCommit?: (text: string) => void;
};

export function openFullscreenEditor(opts: FullscreenEditorOpts): void {
  const overlay = document.createElement("div");
  overlay.className = "fs-editor";

  // ── Top bar ── ← / title / chars / {} / Save
  const bar = document.createElement("div");
  bar.className = "fs-editor-bar";

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "fs-editor-close";
  closeBtn.innerHTML = "&larr;";
  closeBtn.title = "Close (Esc)";
  bar.appendChild(closeBtn);

  if (opts.title) {
    const titleEl = document.createElement("div");
    titleEl.className = "fs-editor-title";
    titleEl.textContent = opts.title;
    bar.appendChild(titleEl);
  } else {
    const spacer = document.createElement("div");
    spacer.className = "fs-editor-spacer";
    bar.appendChild(spacer);
  }

  const charsEl = document.createElement("div");
  charsEl.className = "fs-editor-chars";
  bar.appendChild(charsEl);

  const langSelect = document.createElement("select");
  langSelect.className = "fs-editor-lang";
  for (const lang of LANGUAGES) {
    const o = document.createElement("option");
    o.value = lang.id;
    o.textContent = lang.name;
    langSelect.appendChild(o);
  }
  // Auto-detect from the buffer's first non-blank line. Plain unless the
  // heuristic is confident — the user can override via the picker. If the
  // caller passed initialLanguage (e.g. respecting an inline pick from
  // a fetch result), use that instead.
  langSelect.value = opts.initialLanguage ?? detectLanguage(opts.initialText);
  bar.appendChild(langSelect);

  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "fs-editor-save";
  saveBtn.textContent = "Save";
  bar.appendChild(saveBtn);

  overlay.appendChild(bar);

  // ── Editor area ── gutter (when code) + content (textarea over pre)
  const area = document.createElement("div");
  area.className = "fs-editor-area";

  const gutter = document.createElement("div");
  gutter.className = "fs-editor-gutter";
  area.appendChild(gutter);

  const content = document.createElement("div");
  content.className = "fs-editor-content";

  const highlight = document.createElement("pre");
  highlight.className = "fs-editor-highlight";
  content.appendChild(highlight);

  let textarea: HTMLTextAreaElement | null = null;
  if (opts.editable) {
    textarea = document.createElement("textarea");
    textarea.className = "fs-editor-input";
    textarea.value = opts.initialText;
    textarea.spellcheck = false;
    textarea.autocapitalize = "off";
    textarea.autocomplete = "off";
    content.appendChild(textarea);
  } else {
    // Read-only mode: just the highlighted <pre>, selectable.
    highlight.classList.add("fs-readonly");
  }

  area.appendChild(content);
  overlay.appendChild(area);

  // Lock body scroll while open.
  const prevBodyOverflow = document.body.style.overflow;
  document.body.style.overflow = "hidden";
  document.body.appendChild(overlay);

  // ── State + render ─────────────────────────────────────────────
  let currentText = opts.initialText;
  let currentLang = langSelect.value;

  function refreshChars(): void {
    charsEl.textContent = currentText.length.toLocaleString();
  }
  function refreshGutter(): void {
    if (currentLang === "plain") {
      gutter.classList.remove("fs-gutter-on");
      return;
    }
    gutter.classList.add("fs-gutter-on");
    const lines = currentText.split("\n").length;
    let s = "";
    for (let i = 1; i <= lines; i++) s += i + "\n";
    gutter.textContent = s;
  }
  function refreshHighlight(): void {
    // Trailing newline so the last line has its own row when text ends with \n.
    highlight.innerHTML = highlightAs(currentText, currentLang) + "\n";
  }
  function refreshAll(): void {
    refreshChars();
    refreshGutter();
    refreshHighlight();
    // Wrap mode follows the language: prose-friendly on Plain, code-friendly otherwise.
    if (currentLang === "plain") {
      content.classList.remove("fs-no-wrap");
    } else {
      content.classList.add("fs-no-wrap");
    }
  }
  refreshAll();

  // Debounced re-highlight on input — keeps typing snappy on long docs.
  let hlTimer: number | null = null;
  function scheduleHighlight(): void {
    if (hlTimer !== null) window.clearTimeout(hlTimer);
    if (currentLang === "plain") {
      // Still need to update the pre so wrapping/scroll aligns with the textarea.
      refreshHighlight();
      return;
    }
    hlTimer = window.setTimeout(() => { refreshHighlight(); hlTimer = null; }, 120);
  }

  if (textarea) {
    textarea.addEventListener("input", () => {
      currentText = textarea!.value;
      refreshChars();
      refreshGutter();
      scheduleHighlight();
    });
    // Sync scroll between textarea, highlight pre, and gutter.
    textarea.addEventListener("scroll", () => {
      highlight.scrollTop = textarea!.scrollTop;
      highlight.scrollLeft = textarea!.scrollLeft;
      gutter.scrollTop = textarea!.scrollTop;
    });
    setTimeout(() => {
      textarea!.focus();
      // Open at the top of the document — cursor at 0 and scroll
      // origin reset on the textarea, the highlighted <pre>, and the
      // line-number gutter so they all stay in sync.
      textarea!.setSelectionRange(0, 0);
      textarea!.scrollTop = 0;
      textarea!.scrollLeft = 0;
      highlight.scrollTop = 0;
      highlight.scrollLeft = 0;
      gutter.scrollTop = 0;
    }, 30);
  }

  langSelect.addEventListener("change", () => {
    currentLang = langSelect.value;
    refreshAll();
  });

  // ── Exit paths ──
  function close(): void {
    document.removeEventListener("keydown", keyHandler);
    document.body.style.overflow = prevBodyOverflow;
    overlay.remove();
    if (opts.editable && opts.onCommit) opts.onCommit(currentText);
  }
  function keyHandler(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }
  document.addEventListener("keydown", keyHandler);
  closeBtn.addEventListener("click", close);

  saveBtn.addEventListener("click", () => {
    const blob = new Blob([currentText], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const baseName = (opts.title || "etchit").replace(/[^A-Za-z0-9._-]/g, "_") || "etchit";
    a.download = baseName + ".txt";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });
}
