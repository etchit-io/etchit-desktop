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
