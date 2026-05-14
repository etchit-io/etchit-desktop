import { describe, expect, it } from "vitest";

import { articleTemplate } from "./article";
import type { EditorState, ImageValue } from "../types";

const tinyJpeg: ImageValue = {
  dataUrl: "data:image/jpeg;base64,/9j/4AAQSkZJRg==",
  mimeType: "image/jpeg",
  sizeBytes: 16,
  width: 96,
  height: 54,
  originalSizeBytes: 16,
};

function state(s: {
  title?: string;
  subtitle?: string;
  byline?: string;
  hero?: ImageValue | null;
  body1?: string;
  pullquote?: string;
  body2?: string;
}): EditorState {
  return {
    templateId: "article",
    slots: {
      title: s.title !== undefined ? { kind: "text", value: s.title } : null,
      subtitle: s.subtitle !== undefined ? { kind: "text", value: s.subtitle } : null,
      byline: s.byline !== undefined ? { kind: "text", value: s.byline } : null,
      hero: s.hero ? { kind: "image", image: s.hero } : null,
      "body-1": s.body1 !== undefined ? { kind: "longtext", value: s.body1 } : null,
      pullquote: s.pullquote !== undefined ? { kind: "longtext", value: s.pullquote } : null,
      "body-2": s.body2 !== undefined ? { kind: "longtext", value: s.body2 } : null,
    },
  };
}

const render = articleTemplate.serialize;

describe("article template", () => {
  it("starts with <!DOCTYPE html>", () => {
    expect(render(state({ title: "T", body1: "B" })).startsWith("<!DOCTYPE html>")).toBe(true);
  });

  it("contains no literal etchit brand strings", () => {
    const html = render(state({ title: "T", body1: "B" })).toLowerCase();
    for (const forbidden of ["etchit", "etch/it", "etch>it", "etchit.io"]) {
      expect(html).not.toContain(forbidden);
    }
  });

  it("omits subtitle/byline/hero/pullquote/body-2 blocks when empty", () => {
    const html = render(state({ title: "T", body1: "B" }));
    expect(html).not.toContain('class="subtitle"');
    expect(html).not.toContain('class="byline"');
    expect(html).not.toContain('class="hero"');
    expect(html).not.toContain('class="pull"');
  });

  it("emits subtitle and byline blocks when present", () => {
    const html = render(state({
      title: "T",
      subtitle: "the subtitle",
      byline: "by Author",
      body1: "B",
    }));
    expect(html).toContain('<p class="subtitle">the subtitle</p>');
    expect(html).toContain('<p class="byline">by Author</p>');
  });

  it("emits the pullquote as a blockquote when present", () => {
    const html = render(state({
      title: "T",
      body1: "B",
      pullquote: "a memorable line",
      body2: "more",
    }));
    expect(html).toContain('<blockquote class="pull">a memorable line</blockquote>');
  });

  it("inlines the hero image", () => {
    const html = render(state({ title: "T", hero: tinyJpeg, body1: "B" }));
    expect(html).toContain(tinyJpeg.dataUrl);
    expect(html).toContain('<figure class="hero">');
  });

  it("escapes title, subtitle, byline, and body", () => {
    const html = render(state({
      title: "<a>",
      subtitle: "<b>",
      byline: "<c>",
      body1: "<d>",
    }));
    expect(html).toContain("&lt;a&gt;");
    expect(html).toContain("&lt;b&gt;");
    expect(html).toContain("&lt;c&gt;");
    expect(html).toContain("&lt;d&gt;");
  });

  it("emits aspect-ratio 16/9 + object-fit cover for the hero", () => {
    const html = render(state({ title: "T", hero: tinyJpeg, body1: "B" }));
    expect(html).toMatch(/figure\.hero\s*\{[^}]*aspect-ratio:\s*16\s*\/\s*9/);
    expect(html).toMatch(/figure\.hero\s+img\s*\{[^}]*object-fit:\s*cover/);
  });
});
