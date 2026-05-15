import { describe, expect, it } from "vitest";

import { newEntryId } from "./store";

describe("newEntryId", () => {
  it("returns a short base36 string", () => {
    const id = newEntryId();
    expect(id).toMatch(/^[0-9a-z]+$/);
    expect(id.length).toBeGreaterThanOrEqual(15);
    expect(id.length).toBeLessThanOrEqual(25);
  });

  it("produces distinct ids across calls", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) seen.add(newEntryId());
    expect(seen.size).toBe(100);
  });
});
