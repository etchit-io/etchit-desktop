import { beforeEach, describe, expect, it } from "vitest";

import { loadWalletMode, setWalletMode, WALLET_MODE_CHANGED_EVENT } from "./mode";

describe("walletMode", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults to internal", () => {
    expect(loadWalletMode()).toBe("internal");
  });

  it("persists external", () => {
    setWalletMode("external");
    expect(loadWalletMode()).toBe("external");
  });

  it("persists internal explicitly", () => {
    setWalletMode("external");
    setWalletMode("internal");
    expect(loadWalletMode()).toBe("internal");
  });

  it("dispatches a change event with the new mode", () => {
    return new Promise<void>((resolve) => {
      const handler = (e: Event): void => {
        const detail = (e as CustomEvent).detail;
        expect(detail).toBe("external");
        window.removeEventListener(WALLET_MODE_CHANGED_EVENT, handler);
        resolve();
      };
      window.addEventListener(WALLET_MODE_CHANGED_EVENT, handler);
      setWalletMode("external");
    });
  });

  it("coerces garbage stored values back to internal", () => {
    localStorage.setItem("etchit.walletMode", "nonsense");
    expect(loadWalletMode()).toBe("internal");
  });
});
