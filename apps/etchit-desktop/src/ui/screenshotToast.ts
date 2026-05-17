// SPDX-License-Identifier: AGPL-3.0-only
// "Etch this image?" toast — wired to the clipboard watcher. When the
// user copies an image (or takes a screenshot, which the OS routes
// through the clipboard on every supported platform), we surface a
// small bottom-right toast with a preview and a single Etch button.
// Public-only on purpose: this is the speed-share path. Private etches
// need a title and the encryption ceremony — use the Private tab.
//
// Lifecycle:
//   * watcher fingerprints the rgba; identical bytes don't re-fire
//   * dismissed fingerprints are remembered until process exit so the
//     same image won't keep nagging
//   * if a new image arrives while an upload is in flight, the toast
//     waits — we don't drop user work mid-payment

import { invoke } from "@tauri-apps/api/core";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

import {
  type ClipboardImage,
  startScreenshotWatcher,
} from "../screenshot/clipboardWatcher";
import { formatErr } from "../util/error";
import { uploadBytesViaWallet } from "../wallet/externalUpload";
import { isWalletReady, onReadinessChange } from "../wallet/readiness";
import { historyAppendBestEffort } from "../history/store";
import { renderQrSvg } from "../qr";

interface PromptState {
  kind: "prompt";
  image: ClipboardImage;
  png: Uint8Array;
  previewUrl: string;
  filename: string;
}

interface BusyState {
  kind: "busy";
  image: ClipboardImage;
  previewUrl: string;
  filename: string;
  message: string;
}

interface SuccessState {
  kind: "success";
  image: ClipboardImage;
  previewUrl: string;
  filename: string;
  address: string;
  qrOpen: boolean;
}

interface ErrorState {
  kind: "error";
  image: ClipboardImage;
  png: Uint8Array;
  previewUrl: string;
  filename: string;
  message: string;
}

type ToastState = PromptState | BusyState | SuccessState | ErrorState;

let toastEl: HTMLDivElement | null = null;
let state: ToastState | null = null;
let walletReady = false;
const dismissed = new Set<string>();

/** Mount once. Idempotent. */
export function mountScreenshotToast(): void {
  if (toastEl) return;
  const el = document.createElement("div");
  el.className = "shot-toast";
  el.setAttribute("role", "alert");
  el.setAttribute("aria-live", "polite");
  el.hidden = true;
  document.body.appendChild(el);
  toastEl = el;

  void isWalletReady().then((ready) => {
    walletReady = ready;
  });
  onReadinessChange((ready) => {
    walletReady = ready;
  });

  startScreenshotWatcher((image) => {
    void onNewImage(image);
  });
}

async function onNewImage(image: ClipboardImage): Promise<void> {
  if (dismissed.has(image.fingerprint)) return;
  if (!walletReady) return;
  if (state && (state.kind === "busy" || state.kind === "prompt")) return;
  try {
    const { png, previewUrl } = await encodePng(image);
    if (state?.kind === "success") URL.revokeObjectURL(state.previewUrl);
    state = {
      kind: "prompt",
      image,
      png,
      previewUrl,
      filename: defaultFilename(),
    };
    render();
    // Only ping the OS when etch/it isn't focused. If the user is
    // already looking at us, the in-window toast is enough.
    if (!document.hasFocus()) {
      void maybeNotify(image, png.byteLength);
    }
  } catch {
    // Canvas encode failed — silently skip; will retry on next poll.
  }
}

let notifyAllowed: boolean | null = null;

async function maybeNotify(image: ClipboardImage, pngBytes: number): Promise<void> {
  try {
    if (notifyAllowed === null) {
      let granted = await isPermissionGranted();
      if (!granted) {
        const r = await requestPermission();
        granted = r === "granted";
      }
      notifyAllowed = granted;
    }
    if (!notifyAllowed) return;
    sendNotification({
      title: "Etch this image?",
      body: `${image.width}×${image.height} · ${formatSize(pngBytes)} — click to review in etch/it`,
    });
  } catch {
    // Notification surface unavailable (denied, daemon down). The
    // in-window toast is the fallback.
    notifyAllowed = false;
  }
}

function defaultFilename(): string {
  const d = new Date();
  const pad = (n: number): string => n.toString().padStart(2, "0");
  return `screenshot-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.png`;
}

async function encodePng(
  image: ClipboardImage,
): Promise<{ png: Uint8Array; previewUrl: string }> {
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d unavailable");
  const buf = new Uint8ClampedArray(image.rgba.byteLength);
  buf.set(image.rgba);
  ctx.putImageData(new ImageData(buf, image.width, image.height), 0, 0);
  const blob: Blob = await new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("toBlob failed"))),
      "image/png",
    ),
  );
  const png = new Uint8Array(await blob.arrayBuffer());
  const previewUrl = URL.createObjectURL(blob);
  return { png, previewUrl };
}

function render(): void {
  if (!toastEl || !state) return;
  toastEl.hidden = false;
  toastEl.replaceChildren();

  const preview = document.createElement("img");
  preview.className = "shot-toast-preview";
  preview.src = state.previewUrl;
  preview.alt = "Screenshot preview";

  const body = document.createElement("div");
  body.className = "shot-toast-body";

  switch (state.kind) {
    case "prompt":
      body.appendChild(headline("Etch this image?"));
      body.appendChild(
        hint(
          `${state.image.width}×${state.image.height} · ${formatSize(state.png.byteLength)} · ${state.filename}`,
        ),
      );
      body.appendChild(promptActions(state));
      break;
    case "busy":
      body.appendChild(headline("Etching…"));
      body.appendChild(hint(state.message));
      break;
    case "success":
      body.appendChild(headline("Etched"));
      body.appendChild(addressLine(state.address));
      if (state.qrOpen) body.appendChild(qrPanel(state.address));
      body.appendChild(successActions(state));
      break;
    case "error":
      body.appendChild(headline("Etch failed"));
      body.appendChild(errorLine(state.message));
      body.appendChild(errorActions(state));
      break;
  }

  toastEl.append(preview, body);
}

function headline(text: string): HTMLParagraphElement {
  const p = document.createElement("p");
  p.className = "shot-toast-headline";
  p.textContent = text;
  return p;
}

function hint(text: string): HTMLParagraphElement {
  const p = document.createElement("p");
  p.className = "shot-toast-hint";
  p.textContent = text;
  return p;
}

function addressLine(address: string): HTMLDivElement {
  const wrap = document.createElement("div");
  wrap.className = "shot-toast-address-row";
  const code = document.createElement("code");
  code.className = "shot-toast-address";
  code.textContent = address;
  wrap.appendChild(code);
  return wrap;
}

function errorLine(message: string): HTMLParagraphElement {
  const p = document.createElement("p");
  p.className = "shot-toast-error";
  p.textContent = message;
  return p;
}

function promptActions(s: PromptState): HTMLDivElement {
  const actions = document.createElement("div");
  actions.className = "shot-toast-actions";

  const etchBtn = button("Etch", "shot-toast-primary");
  etchBtn.addEventListener("click", () => {
    void runUpload(s);
  });

  const dismissBtn = button("Dismiss", "shot-toast-secondary");
  dismissBtn.addEventListener("click", () => {
    dismissed.add(s.image.fingerprint);
    URL.revokeObjectURL(s.previewUrl);
    state = null;
    if (toastEl) {
      toastEl.hidden = true;
      toastEl.replaceChildren();
    }
  });

  actions.append(etchBtn, dismissBtn);
  return actions;
}

function successActions(s: SuccessState): HTMLDivElement {
  const actions = document.createElement("div");
  actions.className = "shot-toast-actions";

  const copyBtn = button("Copy address", "shot-toast-primary");
  copyBtn.addEventListener("click", () => {
    void navigator.clipboard
      .writeText(s.address)
      .then(() => {
        copyBtn.textContent = "Copied";
        setTimeout(() => {
          if (state?.kind === "success") copyBtn.textContent = "Copy address";
        }, 1200);
      })
      .catch(() => {
        copyBtn.textContent = "Copy failed";
      });
  });

  const qrBtn = button(s.qrOpen ? "Hide QR" : "Show QR", "shot-toast-secondary");
  qrBtn.addEventListener("click", () => {
    if (state?.kind !== "success") return;
    state = { ...state, qrOpen: !state.qrOpen };
    render();
  });

  const openBtn = brandedButton(
    'Open in fetch<span class="brand-mark">&gt;</span>it',
    "shot-toast-secondary",
  );
  openBtn.addEventListener("click", () => {
    void invoke("open_in_fetchit", { address: s.address }).catch(() => {
      openBtn.innerHTML = 'fetch<span class="brand-mark">&gt;</span>it not installed';
      openBtn.disabled = true;
    });
  });

  const closeBtn = button("Close", "shot-toast-secondary");
  closeBtn.addEventListener("click", () => {
    URL.revokeObjectURL(s.previewUrl);
    state = null;
    if (toastEl) {
      toastEl.hidden = true;
      toastEl.replaceChildren();
    }
  });

  actions.append(copyBtn, qrBtn, openBtn, closeBtn);
  return actions;
}

function qrPanel(address: string): HTMLDivElement {
  const panel = document.createElement("div");
  panel.className = "shot-toast-qr";
  panel.appendChild(
    renderQrSvg(`autonomi://${address}`, {
      cellSize: 4,
      errorCorrectionLevel: "M",
    }),
  );
  return panel;
}

function errorActions(s: ErrorState): HTMLDivElement {
  const actions = document.createElement("div");
  actions.className = "shot-toast-actions";

  const retryBtn = button("Retry", "shot-toast-primary");
  retryBtn.addEventListener("click", () => {
    void runUpload({
      kind: "prompt",
      image: s.image,
      png: s.png,
      previewUrl: s.previewUrl,
      filename: s.filename,
    });
  });

  const dismissBtn = button("Dismiss", "shot-toast-secondary");
  dismissBtn.addEventListener("click", () => {
    dismissed.add(s.image.fingerprint);
    URL.revokeObjectURL(s.previewUrl);
    state = null;
    if (toastEl) {
      toastEl.hidden = true;
      toastEl.replaceChildren();
    }
  });

  actions.append(retryBtn, dismissBtn);
  return actions;
}

function button(label: string, cls: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.textContent = label;
  return b;
}

/** Same as `button` but accepts trusted static markup so we can render
 *  the `fetch<span class="brand-mark">&gt;</span>it` wordmark inside
 *  the button. Never pass user content here. */
function brandedButton(html: string, cls: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.innerHTML = html;
  return b;
}

async function runUpload(s: PromptState): Promise<void> {
  state = {
    kind: "busy",
    image: s.image,
    previewUrl: s.previewUrl,
    filename: s.filename,
    message: "Collecting quotes from the network…",
  };
  render();

  try {
    const result = await uploadBytesViaWallet(
      s.png,
      (msg) => {
        if (state?.kind === "busy") {
          state = { ...state, message: msg };
          render();
        }
      },
      { label: s.filename, historyKind: "file" },
    );
    historyAppendBestEffort(result.address, s.filename, "file", result.chunksStored);
    dismissed.add(s.image.fingerprint);
    state = {
      kind: "success",
      image: s.image,
      previewUrl: s.previewUrl,
      filename: s.filename,
      address: result.address,
      qrOpen: false,
    };
    render();
  } catch (e) {
    state = {
      kind: "error",
      image: s.image,
      png: s.png,
      previewUrl: s.previewUrl,
      filename: s.filename,
      message: formatErr(e),
    };
    render();
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
