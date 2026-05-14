import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyTheme, loadTheme, THEMES } from "./theme";

describe("loadTheme", () => {
  beforeEach(() => localStorage.clear());

  it("defaults to dark when nothing is stored", () => {
    expect(loadTheme()).toBe("dark");
  });

  it("returns a stored theme verbatim", () => {
    localStorage.setItem("etchit-theme", "dim");
    expect(loadTheme()).toBe("dim");
    localStorage.setItem("etchit-theme", "light");
    expect(loadTheme()).toBe("light");
  });

  it("falls back to dark on a junk value", () => {
    localStorage.setItem("etchit-theme", "neon-purple");
    expect(loadTheme()).toBe("dark");
  });
});

describe("applyTheme", () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.removeAttribute("data-theme");
  });
  afterEach(() => document.body.removeAttribute("data-theme"));

  it("sets data-theme on body for each known theme", () => {
    for (const t of THEMES) {
      applyTheme(t);
      expect(document.body.dataset.theme).toBe(t);
    }
  });

  it("persists the choice", () => {
    applyTheme("light");
    expect(localStorage.getItem("etchit-theme")).toBe("light");
  });
});
