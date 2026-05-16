import { beforeEach, describe, expect, it } from "vitest";

import {
  clearPending,
  listPending,
  newPendingId,
  onPendingChange,
  type PendingEtch,
  PENDING_CHANGED_EVENT,
  savePending,
} from "./pendingEtches";

function makeEntry(overrides: Partial<PendingEtch> = {}): PendingEtch {
  return {
    id: newPendingId(),
    label: "test entry",
    uploadId: "upload-xyz",
    payments: [{ rewards_address: "r1", amount: "100", quote_hash: "q1" }],
    payTxHash: "0xabc",
    payer: "0xdef",
    flow: { type: "public", historyKind: "text" },
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("pendingEtches store", () => {
  beforeEach(() => {
    for (const e of listPending()) clearPending(e.id);
  });

  it("starts empty", () => {
    expect(listPending()).toEqual([]);
  });

  it("savePending adds an entry surface in listPending", () => {
    const entry = makeEntry();
    savePending(entry);
    const list = listPending();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(entry.id);
  });

  it("clearPending removes the matching id", () => {
    const a = makeEntry();
    const b = makeEntry();
    savePending(a);
    savePending(b);
    clearPending(a.id);
    const list = listPending();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(b.id);
  });

  it("clearPending is idempotent on unknown ids", () => {
    expect(() => clearPending("never-existed")).not.toThrow();
  });

  it("savePending replaces an entry on same id (upsert)", () => {
    const id = newPendingId();
    savePending(makeEntry({ id, label: "first" }));
    savePending(makeEntry({ id, label: "second" }));
    const list = listPending();
    expect(list).toHaveLength(1);
    expect(list[0].label).toBe("second");
  });

  it("listPending returns newest first by createdAt", () => {
    savePending(makeEntry({ label: "old", createdAt: 100 }));
    savePending(makeEntry({ label: "newer", createdAt: 200 }));
    savePending(makeEntry({ label: "newest", createdAt: 300 }));
    expect(listPending().map((e) => e.label)).toEqual(["newest", "newer", "old"]);
  });

  it("newPendingId returns distinct ids", () => {
    const ids = new Set(Array.from({ length: 32 }, () => newPendingId()));
    expect(ids.size).toBe(32);
  });

  it("dispatches PENDING_CHANGED_EVENT on save", () => {
    return new Promise<void>((resolve) => {
      const handler = (): void => {
        window.removeEventListener(PENDING_CHANGED_EVENT, handler);
        resolve();
      };
      window.addEventListener(PENDING_CHANGED_EVENT, handler);
      savePending(makeEntry());
    });
  });

  it("dispatches PENDING_CHANGED_EVENT on clear", () => {
    const entry = makeEntry();
    savePending(entry);
    return new Promise<void>((resolve) => {
      const handler = (): void => {
        window.removeEventListener(PENDING_CHANGED_EVENT, handler);
        resolve();
      };
      window.addEventListener(PENDING_CHANGED_EVENT, handler);
      clearPending(entry.id);
    });
  });

  it("does NOT dispatch on clearing an unknown id (no spurious refresh)", () => {
    let fired = false;
    const handler = (): void => {
      fired = true;
    };
    window.addEventListener(PENDING_CHANGED_EVENT, handler);
    clearPending("never-existed");
    window.removeEventListener(PENDING_CHANGED_EVENT, handler);
    expect(fired).toBe(false);
  });

  it("onPendingChange returns a working unsubscribe", () => {
    let count = 0;
    const unsub = onPendingChange(() => {
      count++;
    });
    savePending(makeEntry());
    expect(count).toBe(1);
    unsub();
    savePending(makeEntry());
    expect(count).toBe(1);
  });

  it("carries the private flow shape (dataMap + meta)", () => {
    const entry = makeEntry({
      flow: {
        type: "private",
        dataMap: "deadbeef",
        walletMode: "external",
        walletAddress: "0xabc",
        sizeBytes: 1024,
        kind: "file",
        originalFilename: "report.pdf",
      },
    });
    savePending(entry);
    const round = listPending()[0];
    expect(round.flow.type).toBe("private");
    if (round.flow.type === "private") {
      expect(round.flow.dataMap).toBe("deadbeef");
      expect(round.flow.originalFilename).toBe("report.pdf");
    }
  });
});
