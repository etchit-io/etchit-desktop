// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  isScreenshotWatchEnabled,
  SCREENSHOT_PREF_CHANGED_EVENT,
  setScreenshotWatchEnabled,
} from "./settings";

describe("screenshot settings", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults to off", () => {
    expect(isScreenshotWatchEnabled()).toBe(false);
  });

  it("round-trips on/off", () => {
    setScreenshotWatchEnabled(true);
    expect(isScreenshotWatchEnabled()).toBe(true);
    setScreenshotWatchEnabled(false);
    expect(isScreenshotWatchEnabled()).toBe(false);
  });

  it("ignores garbage values left in storage", () => {
    localStorage.setItem("etchit.screenshotClipboard", "yes");
    expect(isScreenshotWatchEnabled()).toBe(false);
  });

  it("dispatches a change event with the new state", () => {
    const seen: boolean[] = [];
    const handler = (e: Event): void => {
      seen.push((e as CustomEvent<boolean>).detail);
    };
    window.addEventListener(SCREENSHOT_PREF_CHANGED_EVENT, handler);
    setScreenshotWatchEnabled(true);
    setScreenshotWatchEnabled(false);
    window.removeEventListener(SCREENSHOT_PREF_CHANGED_EVENT, handler);
    expect(seen).toEqual([true, false]);
  });

  it("still dispatches when localStorage throws", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    const seen: boolean[] = [];
    const handler = (e: Event): void => {
      seen.push((e as CustomEvent<boolean>).detail);
    };
    window.addEventListener(SCREENSHOT_PREF_CHANGED_EVENT, handler);
    setScreenshotWatchEnabled(true);
    window.removeEventListener(SCREENSHOT_PREF_CHANGED_EVENT, handler);
    setItem.mockRestore();
    expect(seen).toEqual([true]);
  });
});
