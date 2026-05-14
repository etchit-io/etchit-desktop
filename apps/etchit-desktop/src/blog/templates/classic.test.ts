import { describe, expect, it } from "vitest";

import { classicTemplate } from "./classic";
import type { EditorState } from "../types";

function state(slots: { title?: string; lede?: string; body?: string }): EditorState {
  return {
    templateId: "classic",
    slots: {
      title: slots.title !== undefined ? { kind: "text", value: slots.title } : null,
      lede: slots.lede !== undefined ? { kind: "text", value: slots.lede } : null,
      body: slots.body !== undefined ? { kind: "longtext", value: slots.body } : null,
    },
  };
}

const render = classicTemplate.serialize;

describe("classic template", () => {
  it("starts with <!DOCTYPE html> so fetch>it picks the HTML renderer", () => {
    expect(render(state({ title: "T", body: "B" })).startsWith("<!DOCTYPE html>")).toBe(true);
  });

  it("contains no literal etchit brand strings", () => {
    const html = render(state({ title: "T", body: "B" })).toLowerCase();
    for (const forbidden of ["etchit", "etch/it", "etch>it", "etchit.io"]) {
      expect(html).not.toContain(forbidden);
    }
  });

  it("contains no `generator` meta", () => {
    const html = render(state({ title: "T", body: "B" })).toLowerCase();
    expect(html).not.toContain('name="generator"');
  });

  it("escapes title and body", () => {
    const html = render(state({ title: "<x>", body: "&\"<>" }));
    expect(html).toContain("&lt;x&gt;");
    expect(html).toContain("&amp;");
    expect(html).not.toContain("<x>");
  });

  it("renders an explicit placeholder when body is empty", () => {
    const html = render(state({ title: "T", body: "   " }));
    expect(html).toContain("(this post has no body)");
  });

  it("omits the lede block when lede is empty", () => {
    const html = render(state({ title: "T", body: "B" }));
    expect(html).not.toContain('class="lede"');
  });

  it("emits the lede block when lede is present", () => {
    const html = render(state({ title: "T", lede: "intro line", body: "B" }));
    expect(html).toContain('<p class="lede">intro line</p>');
  });

  it("splits paragraphs on blank lines", () => {
    const html = render(state({ title: "T", body: "one\n\ntwo\n\nthree" }));
    expect(html.match(/<p>/g)?.length).toBe(3);
  });

  it("collapses internal whitespace within a paragraph", () => {
    const html = render(state({ title: "T", body: "hello    world\nfoo\tbar" }));
    expect(html).toContain("<p>hello world foo bar</p>");
  });

  it("trims the title", () => {
    const html = render(state({ title: "  spaced  ", body: "B" }));
    expect(html).toContain("<title>spaced</title>");
    expect(html).toContain(">spaced</h1>");
  });

  it("emits the dark palette by default", () => {
    const html = render(state({ title: "T", body: "B" }));
    expect(html).toContain("--ink: #0a0a0a");
    expect(html).toContain("--bone: #f5f2eb");
  });

  it("emits the light palette when requested", () => {
    const html = render(state({ title: "T", body: "B" }), { palette: "light" });
    expect(html).toContain("--ink: #f5f2eb");
    expect(html).toContain("--bone: #1a1814");
  });
});
