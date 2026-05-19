import { invoke } from "@tauri-apps/api/core";

import { bindFileDropSlot } from "../util/dragDrop";
import type { EditorState, ImageValue, Slot, SlotValue, Template } from "./types";
import { processImage } from "./imageProcessor";

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  heic: "image/heic",
  svg: "image/svg+xml",
  bmp: "image/bmp",
};

async function fileFromPath(path: string): Promise<File> {
  const bytes = await invoke<number[]>("read_file_bytes", { path });
  const name = path.split(/[\\/]/).pop() ?? "image";
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const mime = IMAGE_MIME[ext] ?? "application/octet-stream";
  return new File([new Uint8Array(bytes)], name, { type: mime });
}

export interface ComposerHandle {
  getState(): EditorState;
  isReady(): boolean;
  totalImageBytes(): number;
  wordCount(): number;
  onChange(handler: () => void): void;
}

export function mountComposer(host: HTMLElement, template: Template): ComposerHandle {
  host.innerHTML = `<div class="blog-composer" data-template="${template.id}"></div>`;
  const canvas = host.querySelector(".blog-composer") as HTMLElement;

  const state: Record<string, SlotValue | null> = {};
  for (const slot of template.slots) state[slot.id] = null;

  const listeners: Array<() => void> = [];
  const notify = (): void => {
    for (const h of listeners) h();
  };

  // Build every slot's wired-up element up front. If the template wants
  // a custom layout (image left, body right, etc.) it places these into
  // the container itself; otherwise we stack them in declaration order.
  const slotElements: Record<string, HTMLElement> = {};
  for (const slot of template.slots) {
    const slotEl = renderSlot(slot);
    wireSlot(slotEl, slot, state, notify);
    slotElements[slot.id] = slotEl;
  }
  if (template.layoutEditor) {
    template.layoutEditor(slotElements, canvas);
  } else {
    for (const slot of template.slots) canvas.appendChild(slotElements[slot.id]);
  }

  return {
    getState: () => ({ templateId: template.id, slots: { ...state } }),
    isReady: () => template.slots.every((s) => s.optional || hasValue(state[s.id])),
    totalImageBytes: () => sumImageBytes(state),
    wordCount: () => countWords(state),
    onChange: (h) => {
      listeners.push(h);
    },
  };
}

/** Build the DOM for one slot — the wrapper div + the appropriate
 *  input/textarea/dropzone inside. Wiring happens separately in
 *  [`wireSlot`]. Exported so the Website composer can reuse the same
 *  drop zone, image processor, drag/zoom — every primitive — for its
 *  per-page slot fields. */
export function renderSlot(slot: Slot): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = `composer-slot composer-${slot.kind} slot-${slot.id}`;
  wrap.dataset.slotId = slot.id;

  switch (slot.kind) {
    case "text": {
      const input = document.createElement("input");
      input.type = "text";
      input.className = "composer-input";
      input.placeholder = slot.placeholder;
      input.spellcheck = true;
      wrap.appendChild(input);
      break;
    }
    case "longtext": {
      const ta = document.createElement("textarea");
      ta.className = "composer-textarea";
      ta.placeholder = slot.placeholder;
      ta.rows = 6;
      wrap.appendChild(ta);
      break;
    }
    case "image": {
      const drop = document.createElement("div");
      drop.className = "composer-drop";
      if (slot.aspect) {
        drop.classList.add("has-aspect");
        drop.style.aspectRatio = `${slot.aspect.width} / ${slot.aspect.height}`;
      }
      const aspectHint = slot.aspect
        ? `<span class="composer-drop-aspect">${slot.aspect.width}:${slot.aspect.height} recommended</span>`
        : "";
      drop.innerHTML = `
        <div class="composer-drop-empty">
          <p class="composer-drop-prompt">${escapeAttr(slot.placeholder)}</p>
          <p class="composer-drop-hint">
            drag here or <button type="button" class="composer-drop-pick">choose a file</button>
            ${aspectHint}
          </p>
          <p class="composer-drop-privacy">
            metadata stripped and resized for you — your camera data stays yours.
          </p>
          <input type="file" accept="image/*" class="composer-drop-file" hidden>
        </div>
        <div class="composer-drop-processing" hidden>
          <p>cleaning &amp; resizing…</p>
        </div>
        <div class="composer-drop-preview" hidden>
          <img alt="" class="composer-drop-img">
          <div class="composer-drop-meta">
            <span class="composer-drop-size"></span>
            <button type="button" class="composer-drop-clear">Remove</button>
          </div>
        </div>
      `;
      wrap.appendChild(drop);
      break;
    }
  }
  return wrap;
}

/** Attach input handlers to a slot built by [`renderSlot`]. Updates
 *  the supplied state map in place and calls `notify` on every change.
 *  Exported so the Website composer can wire the same primitives. */
export function wireSlot(
  el: HTMLElement,
  slot: Slot,
  state: Record<string, SlotValue | null>,
  notify: () => void,
): void {
  if (slot.kind === "text") {
    const input = el.querySelector("input") as HTMLInputElement;
    input.addEventListener("input", () => {
      state[slot.id] = { kind: "text", value: input.value };
      notify();
    });
    return;
  }
  if (slot.kind === "longtext") {
    const ta = el.querySelector("textarea") as HTMLTextAreaElement;
    ta.addEventListener("input", () => {
      state[slot.id] = { kind: "longtext", value: ta.value };
      notify();
    });
    return;
  }
  wireImageSlot(el, slot, state, notify);
}

function wireImageSlot(
  el: HTMLElement,
  slot: Slot,
  state: Record<string, SlotValue | null>,
  notify: () => void,
): void {
  const drop = el.querySelector(".composer-drop") as HTMLElement;
  const empty = el.querySelector(".composer-drop-empty") as HTMLElement;
  const processing = el.querySelector(".composer-drop-processing") as HTMLElement;
  const preview = el.querySelector(".composer-drop-preview") as HTMLElement;
  const fileInput = el.querySelector(".composer-drop-file") as HTMLInputElement;
  const pickBtn = el.querySelector(".composer-drop-pick") as HTMLButtonElement;
  const img = el.querySelector(".composer-drop-img") as HTMLImageElement;
  const sizeEl = el.querySelector(".composer-drop-size") as HTMLElement;
  const clearBtn = el.querySelector(".composer-drop-clear") as HTMLButtonElement;

  const showEmpty = (): void => {
    empty.hidden = false;
    processing.hidden = true;
    preview.hidden = true;
  };
  const showProcessing = (): void => {
    empty.hidden = true;
    processing.hidden = false;
    preview.hidden = true;
  };
  const showPreview = (): void => {
    empty.hidden = true;
    processing.hidden = true;
    preview.hidden = false;
  };

  const set = (image: ImageValue | null): void => {
    if (image) {
      state[slot.id] = { kind: "image", image };
      img.src = image.dataUrl;
      applyImageTransform(img, image);
      const sizeNow = formatBytes(image.sizeBytes);
      const sizeOrig = formatBytes(image.originalSizeBytes);
      sizeEl.textContent = image.originalSizeBytes > image.sizeBytes * 1.15
        ? `${sizeOrig} → ${sizeNow}`
        : sizeNow;
      showPreview();
    } else {
      state[slot.id] = null;
      img.removeAttribute("src");
      img.style.removeProperty("object-position");
      img.style.removeProperty("transform");
      img.style.removeProperty("transform-origin");
      showEmpty();
    }
    notify();
  };

  if (slot.aspect) {
    img.style.cursor = "move";
    img.title = "drag to reframe · scroll or double-click to zoom";
    wireDragToCrop(img, slot, state, notify);
    wireWheelZoom(img, slot, state, notify);
    wireDoubleClickZoom(img, slot, state, notify);
  }

  const onFile = async (file: File): Promise<void> => {
    if (!file.type.startsWith("image/")) return;
    showProcessing();
    try {
      const processed = await processImage(file);
      set({
        dataUrl: processed.dataUrl,
        mimeType: processed.mimeType,
        sizeBytes: processed.sizeBytes,
        width: processed.width,
        height: processed.height,
        originalSizeBytes: processed.originalSizeBytes,
      });
    } catch (e) {
      console.error("[blog] image processing failed:", e);
      showEmpty();
    }
  };

  pickBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    fileInput.click();
  });
  fileInput.addEventListener("change", () => {
    const f = fileInput.files?.[0];
    if (f) void onFile(f);
  });
  clearBtn.addEventListener("click", () => set(null));

  // Tauri intercepts OS-level file drops before the WebView's HTML5
  // dragover/drop ever fires — pull paths off Tauri's event instead
  // and round-trip through the backend read_file_bytes command to
  // reconstruct a File the existing onFile / processImage flow expects.
  bindFileDropSlot(drop, (paths) => {
    const path = paths[0];
    if (!path) return;
    void (async () => {
      try {
        const file = await fileFromPath(path);
        await onFile(file);
      } catch (e) {
        console.error("[blog] drop read failed:", e);
        showEmpty();
      }
    })();
  });
}

/** Whether a slot has user-entered content. Exposed for reuse. */
export function hasValue(v: SlotValue | null): boolean {
  if (v === null) return false;
  if (v.kind === "image") return true;
  return v.value.trim().length > 0;
}

/** Total bytes across every image-kind slot in a state map. Exposed
 *  for reuse by the Website composer's aggregate sizing. */
export function sumImageBytes(state: Record<string, SlotValue | null>): number {
  let sum = 0;
  for (const v of Object.values(state)) {
    if (v?.kind === "image") sum += v.image.sizeBytes;
  }
  return sum;
}

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;
const ZOOM_STEP_PER_PIXEL = 0.003;

/** Discrete zoom levels cycled by double-click — works on every input
 *  device including trackpads that don't fire wheel events. Sequence:
 *  default → narrower frame (zoom out, letterboxed) → tighter (zoom in)
 *  → back to default. */
const DOUBLE_CLICK_SCALES = [1, 0.7, 1.3] as const;

/** Pure helper — exposed for testing the dblclick cycle. */
export function nextDoubleClickScale(current: number): number {
  const idx = DOUBLE_CLICK_SCALES.findIndex((s) => Math.abs(s - current) < 0.01);
  if (idx === -1) return 1;
  return DOUBLE_CLICK_SCALES[(idx + 1) % DOUBLE_CLICK_SCALES.length];
}

function wireDoubleClickZoom(
  img: HTMLImageElement,
  slot: Slot,
  state: Record<string, SlotValue | null>,
  notify: () => void,
): void {
  if (!slot.aspect) return;
  img.addEventListener("dblclick", (e) => {
    e.preventDefault();
    const cur = state[slot.id];
    if (!cur || cur.kind !== "image") return;
    const next = nextDoubleClickScale(cur.image.scale ?? 1);
    state[slot.id] = {
      kind: "image",
      image: { ...cur.image, scale: next },
    };
    applyImageTransform(img, (state[slot.id] as { kind: "image"; image: ImageValue }).image);
    notify();
  });
}

function wireWheelZoom(
  img: HTMLImageElement,
  slot: Slot,
  state: Record<string, SlotValue | null>,
  notify: () => void,
): void {
  if (!slot.aspect) return;
  img.addEventListener(
    "wheel",
    (e) => {
      const cur = state[slot.id];
      if (!cur || cur.kind !== "image") return;
      e.preventDefault();
      const currentScale = cur.image.scale ?? 1;
      // deltaY > 0 means scrolling down → zoom out (smaller scale).
      const next = clamp(currentScale - e.deltaY * ZOOM_STEP_PER_PIXEL, MIN_ZOOM, MAX_ZOOM);
      if (Math.abs(next - currentScale) < 0.001) return;
      state[slot.id] = {
        kind: "image",
        image: { ...cur.image, scale: next },
      };
      applyImageTransform(img, (state[slot.id] as { kind: "image"; image: ImageValue }).image);
      notify();
    },
    { passive: false },
  );
}

function wireDragToCrop(
  img: HTMLImageElement,
  slot: Slot,
  state: Record<string, SlotValue | null>,
  notify: () => void,
): void {
  if (!slot.aspect) return;
  img.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    const cur = state[slot.id];
    if (!cur || cur.kind !== "image") return;
    const startMouse = { x: e.clientX, y: e.clientY };
    const startPos = cur.image.objectPosition ?? { x: 50, y: 50 };
    const frame = { w: img.clientWidth, h: img.clientHeight };
    const natural = { w: cur.image.width, h: cur.image.height };
    e.preventDefault();
    const onMove = (ev: MouseEvent): void => {
      const next = computePan(frame, natural, startPos, ev.clientX - startMouse.x, ev.clientY - startMouse.y);
      const x = next.x.toFixed(1);
      const y = next.y.toFixed(1);
      img.style.objectPosition = `${x}% ${y}%`;
      // Keep transform-origin in sync with the pan so zoom focuses on
      // the currently-dragged-to point.
      if (img.style.transform.length > 0) {
        img.style.transformOrigin = `${x}% ${y}%`;
      }
    };
    const onUp = (ev: MouseEvent): void => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      const next = computePan(frame, natural, startPos, ev.clientX - startMouse.x, ev.clientY - startMouse.y);
      const current = state[slot.id];
      if (current?.kind === "image") {
        state[slot.id] = {
          kind: "image",
          image: { ...current.image, objectPosition: next },
        };
        notify();
      }
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

function applyImageTransform(img: HTMLImageElement, image: ImageValue): void {
  const pos = image.objectPosition;
  const scale = image.scale ?? 1;
  if (pos && (pos.x !== 50 || pos.y !== 50)) {
    img.style.objectPosition = `${pos.x.toFixed(1)}% ${pos.y.toFixed(1)}%`;
  } else {
    img.style.removeProperty("object-position");
  }
  if (scale !== 1) {
    const ox = pos ? pos.x.toFixed(1) : "50";
    const oy = pos ? pos.y.toFixed(1) : "50";
    img.style.transform = `scale(${scale.toFixed(3)})`;
    img.style.transformOrigin = `${ox}% ${oy}%`;
  } else {
    img.style.removeProperty("transform");
    img.style.removeProperty("transform-origin");
  }
}

/** Pure helper — exposed for direct testing without mounting a composer.
 *  Maps a pointer drag (in CSS pixels) to the new `object-position` for
 *  an aspect-cropped image. Pulling the image right reveals more of its
 *  left side, so X decreases as `dx` increases. */
export function computePan(
  frame: { w: number; h: number },
  natural: { w: number; h: number },
  startPos: { x: number; y: number },
  dx: number,
  dy: number,
): { x: number; y: number } {
  const scale = Math.max(frame.w / natural.w, frame.h / natural.h);
  const overflowX = Math.max(0, natural.w * scale - frame.w);
  const overflowY = Math.max(0, natural.h * scale - frame.h);
  const dXpct = overflowX > 0 ? (dx / overflowX) * 100 : 0;
  const dYpct = overflowY > 0 ? (dy / overflowY) * 100 : 0;
  return {
    x: clamp(startPos.x - dXpct, 0, 100),
    y: clamp(startPos.y - dYpct, 0, 100),
  };
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/** Pure helper — exposed for direct testing without mounting a composer. */
export function countWords(state: Record<string, SlotValue | null>): number {
  let n = 0;
  for (const v of Object.values(state)) {
    if (v && (v.kind === "text" || v.kind === "longtext")) {
      const trimmed = v.value.trim();
      if (trimmed.length > 0) n += trimmed.split(/\s+/).length;
    }
  }
  return n;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
