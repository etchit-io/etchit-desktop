// SPDX-License-Identifier: AGPL-3.0-only
// Persistent toggle for the "etch image from clipboard" feature.
// Default off — when enabled the watcher polls the clipboard, which is
// a privacy-sensitive surface, so users opt in deliberately. Stored
// in localStorage; per-device.

const STORAGE_KEY = "etchit.screenshotClipboard";

/** Fired on toggle so the watcher can start/stop without a reload. */
export const SCREENSHOT_PREF_CHANGED_EVENT = "etchit:screenshot-pref-changed";

/** Read the toggle. Returns false if storage is unavailable. */
export function isScreenshotWatchEnabled(): boolean {
  if (typeof localStorage === "undefined") return false;
  return localStorage.getItem(STORAGE_KEY) === "on";
}

/** Persist + announce the new state. */
export function setScreenshotWatchEnabled(on: boolean): void {
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(STORAGE_KEY, on ? "on" : "off");
    } catch {
      // Quota / disabled storage — still dispatch so the in-session
      // watcher reacts; the choice just won't survive a relaunch.
    }
  }
  window.dispatchEvent(
    new CustomEvent<boolean>(SCREENSHOT_PREF_CHANGED_EVENT, { detail: on }),
  );
}
