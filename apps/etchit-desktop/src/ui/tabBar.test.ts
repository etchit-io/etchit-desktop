import { beforeEach, describe, expect, it, vi } from "vitest";
import { mountTabBar } from "./tabBar";
import { TAB_IDS } from "../types";

function makeHost(): HTMLElement {
  const el = document.createElement("nav");
  document.body.appendChild(el);
  return el;
}

describe("mountTabBar", () => {
  beforeEach(() => (document.body.innerHTML = ""));

  it("renders one button per known tab id", () => {
    const host = makeHost();
    mountTabBar(host, "etch", () => {});
    expect(host.querySelectorAll("button.tab-bar-item")).toHaveLength(TAB_IDS.length);
  });

  it("marks the initial tab active", () => {
    const host = makeHost();
    mountTabBar(host, "wallet", () => {});
    const active = host.querySelector(".tab-bar-item.is-active") as HTMLButtonElement;
    expect(active.dataset.tab).toBe("wallet");
    expect(active.getAttribute("aria-selected")).toBe("true");
  });

  it("emits onChange when a different tab is clicked", () => {
    const host = makeHost();
    const cb = vi.fn();
    mountTabBar(host, "etch", cb);
    (host.querySelector('[data-tab="blogger"]') as HTMLButtonElement).click();
    expect(cb).toHaveBeenCalledWith("blogger");
  });

  it("does not emit onChange when the active tab is re-clicked", () => {
    const host = makeHost();
    const cb = vi.fn();
    mountTabBar(host, "etch", cb);
    (host.querySelector('[data-tab="etch"]') as HTMLButtonElement).click();
    expect(cb).not.toHaveBeenCalled();
  });

  it("getActive reflects the latest setActive", () => {
    const host = makeHost();
    const api = mountTabBar(host, "etch", () => {});
    api.setActive("history");
    expect(api.getActive()).toBe("history");
  });
});
