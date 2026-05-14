import { describe, expect, it } from "vitest";

import { noteTemplate } from "./note";
import type { EditorState } from "../types";

function state(s: { date?: string; body?: string }): EditorState {
  return {
    templateId: "note",
    slots: {
      date: s.date !== undefined ? { kind: "text", value: s.date } : null,
      body: s.body !== undefined ? { kind: "longtext", value: s.body } : null,
    },
  };
}

const render = noteTemplate.serialize;

describe("note template", () => {
  it("starts with <!DOCTYPE html>", () => {
    expect(render(state({ body: "x" })).startsWith("<!DOCTYPE html>")).toBe(true);
  });

  it("contains no literal etchit brand strings", () => {
    const html = render(state({ body: "x" })).toLowerCase();
    for (const forbidden of ["etchit", "etch/it", "etch>it", "etchit.io"]) {
      expect(html).not.toContain(forbidden);
    }
  });

  it("omits date when empty", () => {
    const html = render(state({ body: "x" }));
    expect(html).not.toContain('class="date"');
  });

  it("emits the date when set", () => {
    const html = render(state({ date: "today", body: "x" }));
    expect(html).toContain('<p class="date">today</p>');
  });

  it("uses date as <title> when set, falls back otherwise", () => {
    expect(render(state({ date: "today", body: "x" }))).toContain("<title>today</title>");
    expect(render(state({ body: "x" }))).toContain("<title>note</title>");
  });

  it("escapes the body", () => {
    const html = render(state({ body: "<x>" }));
    expect(html).toContain("&lt;x&gt;");
  });

  it("renders an empty-note placeholder for blank input", () => {
    const html = render(state({ body: "   " }));
    expect(html).toContain("(empty note)");
  });
});
