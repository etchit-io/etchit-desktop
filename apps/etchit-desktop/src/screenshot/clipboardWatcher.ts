// SPDX-License-Identifier: AGPL-3.0-only
// Polls the OS clipboard for a fresh image and fires a callback when
// one shows up. Tauri 2's clipboard plugin has no native change event,
// so we poll at a slow cadence + opportunistically check on window
// focus (covers the common alt-tab-back-to-etchit pattern). Hashing
// the raw rgba lets us cheaply dedupe against the previous read; only
// genuinely new images trigger the callback.

import { readImage } from "@tauri-apps/plugin-clipboard-manager";

import {
  isScreenshotWatchEnabled,
  SCREENSHOT_PREF_CHANGED_EVENT,
} from "./settings";

/** A clipboard image, in the shape the toast consumes. */
export interface ClipboardImage {
  /** Row-major RGBA pixel data, top-to-bottom. */
  rgba: Uint8Array;
  /** Pixel width. */
  width: number;
  /** Pixel height. */
  height: number;
  /** Stable content key — identical bytes ⇒ identical fingerprint. */
  fingerprint: string;
}

/** Callback invoked once per genuinely new clipboard image. */
export type OnImage = (image: ClipboardImage) => void;

const POLL_MS = 3000;

// When etchit itself writes an image to the clipboard (e.g. the QR
// share modal's "Copy image" action), the next poll would naively see
// a new image and trigger an "etch this image?" prompt for the user's
// own QR card. We expose this short-lived suppression so the writer
// can mark "expect a self-write in the next few seconds, ignore it."
// After the window expires, normal polling resumes; the freshly
// suppressed image becomes the watcher's `lastFingerprint` on the
// next tick so genuinely-new screenshots still surface.
let suppressUntilMs = 0;

/**
 * Tell the watcher to skip clipboard reads for the next `ttlMs`. Used
 * by code paths that put an image on the clipboard on purpose. Default
 * window is generous (8s) because the watcher only polls every
 * `POLL_MS` (3s) and we want to cover at least one full cycle.
 */
export function suppressNextClipboardImage(ttlMs = 8000): void {
  suppressUntilMs = Date.now() + ttlMs;
}

/** Pure dedupe key. Exported for unit testing. Width + height + length
 *  + 16 bytes from each end of the buffer is enough to distinguish
 *  distinct captures without hashing megabytes on every poll. */
export function fingerprintRgba(
  rgba: Uint8Array,
  width: number,
  height: number,
): string {
  const tip = (start: number, n: number): string => {
    const end = Math.min(rgba.length, start + n);
    let out = "";
    for (let i = start; i < end; i++) {
      out += rgba[i].toString(16).padStart(2, "0");
    }
    return out;
  };
  const tail = Math.max(0, rgba.length - 16);
  return `${width}x${height}.${rgba.length}.${tip(0, 16)}.${tip(tail, 16)}`;
}

/** Start the polling loop. Returns a teardown function. */
export function startScreenshotWatcher(onImage: OnImage): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastFingerprint: string | null = null;

  const tick = async (): Promise<void> => {
    if (!isScreenshotWatchEnabled()) return;
    // Skip when a self-write is expected on the clipboard (e.g. QR
    // share modal's Copy image). We still pull the current fingerprint
    // so subsequent polls dedupe against it — otherwise the moment the
    // suppression window expires, the watcher would discover the
    // self-write as a "new" image.
    if (Date.now() < suppressUntilMs) {
      try {
        const img = await readImage();
        const [rgba, size] = await Promise.all([img.rgba(), img.size()]);
        lastFingerprint = fingerprintRgba(rgba, size.width, size.height);
      } catch {
        // Clipboard empty / unsupported — leave lastFingerprint alone.
      }
      return;
    }
    try {
      const img = await readImage();
      const [rgba, size] = await Promise.all([img.rgba(), img.size()]);
      const fp = fingerprintRgba(rgba, size.width, size.height);
      if (fp === lastFingerprint) return;
      lastFingerprint = fp;
      onImage({ rgba, width: size.width, height: size.height, fingerprint: fp });
    } catch {
      // No image in the clipboard, or the platform doesn't support
      // readImage. Either way there's nothing to surface.
    }
  };

  const start = (): void => {
    if (timer !== null) return;
    timer = setInterval(() => void tick(), POLL_MS);
  };
  const stop = (): void => {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  };

  if (isScreenshotWatchEnabled()) start();

  const onPrefChange = (e: Event): void => {
    const on = (e as CustomEvent<boolean>).detail;
    if (on) {
      // The user just enabled the feature; force the next image
      // through even if it was already sitting in the clipboard.
      lastFingerprint = null;
      start();
      void tick();
    } else {
      stop();
    }
  };
  const onFocus = (): void => {
    if (isScreenshotWatchEnabled()) void tick();
  };
  window.addEventListener(SCREENSHOT_PREF_CHANGED_EVENT, onPrefChange);
  window.addEventListener("focus", onFocus);

  return (): void => {
    stop();
    window.removeEventListener(SCREENSHOT_PREF_CHANGED_EVENT, onPrefChange);
    window.removeEventListener("focus", onFocus);
  };
}
