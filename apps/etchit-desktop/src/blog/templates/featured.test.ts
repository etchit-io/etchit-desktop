import { describe, expect, it } from "vitest";

import { featuredTemplate } from "./featured";
import type { EditorState, ImageValue } from "../types";

const tinyJpeg: ImageValue = {
  dataUrl: "data:image/jpeg;base64,/9j/4AAQSkZJRg==",
  mimeType: "image/jpeg",
  sizeBytes: 16,
  width: 64,
  height: 64,
  originalSizeBytes: 16,
};

function state(s: {
  title?: string;
  subtitle?: string;
  hero?: ImageValue;
  body1?: string;
  body2?: string;
}): EditorState {
  return {
    templateId: "featured",
    slots: {
      title: s.title !== undefined ? { kind: "text", value: s.title } : null,
      subtitle: s.subtitle !== undefined ? { kind: "text", value: s.subtitle } : null,
      hero: s.hero ? { kind: "image", image: s.hero } : null,
      "body-1": s.body1 !== undefined ? { kind: "longtext", value: s.body1 } : null,
      "body-2": s.body2 !== undefined ? { kind: "longtext", value: s.body2 } : null,
    },
  };
}

const render = featuredTemplate.serialize;

describe("featured template", () => {
  it("starts with <!DOCTYPE html>", () => {
    expect(render(state({ title: "T", hero: tinyJpeg, body1: "B" })).startsWith("<!DOCTYPE html>")).toBe(true);
  });

  it("contains no literal etchit brand strings", () => {
    const html = render(state({ title: "T", hero: tinyJpeg, body1: "B" })).toLowerCase();
    for (const forbidden of ["etchit", "etch/it", "etch>it", "etchit.io"]) {
      expect(html).not.toContain(forbidden);
    }
  });

  it("emits a featured-grid wrapper containing hero + side-text", () => {
    const html = render(state({ title: "T", hero: tinyJpeg, body1: "B" }));
    expect(html).toContain('<div class="featured-grid">');
    expect(html).toContain('<figure class="hero">');
    expect(html).toContain('<div class="side-text">');
  });

  it("renders a 1:1 hero with object-fit cover", () => {
    const html = render(state({ title: "T", hero: tinyJpeg, body1: "B" }));
    expect(html).toMatch(/figure\.hero\s*\{[^}]*aspect-ratio:\s*1\s*\/\s*1/);
    expect(html).toMatch(/figure\.hero\s+img\s*\{[^}]*object-fit:\s*cover/);
  });

  it("omits subtitle and body-2 blocks when empty", () => {
    const html = render(state({ title: "T", hero: tinyJpeg, body1: "B" }));
    expect(html).not.toContain('class="subtitle"');
    expect(html).toContain("<article></article>");
  });

  it("emits subtitle when provided", () => {
    const html = render(state({
      title: "T",
      subtitle: "Subtitle line",
      hero: tinyJpeg,
      body1: "B",
    }));
    expect(html).toContain('<p class="subtitle">Subtitle line</p>');
  });

  it("places body-1 inside the side-text grid cell, body-2 in the article", () => {
    const html = render(state({
      title: "T",
      hero: tinyJpeg,
      body1: "left side text",
      body2: "below the grid",
    }));
    expect(html).toMatch(/<div class="side-text">[\s\S]*left side text[\s\S]*<\/div>/);
    expect(html).toMatch(/<article>[\s\S]*below the grid[\s\S]*<\/article>/);
  });

  it("escapes title, subtitle, and body content", () => {
    const html = render(state({
      title: "<bad>",
      subtitle: "<x>",
      hero: tinyJpeg,
      body1: "<dangerous>",
    }));
    expect(html).toContain("&lt;bad&gt;");
    expect(html).toContain("&lt;x&gt;");
    expect(html).toContain("&lt;dangerous&gt;");
  });

  it("declares layoutEditor so the composer mirrors the side-by-side layout", () => {
    expect(typeof featuredTemplate.layoutEditor).toBe("function");
  });

  it("collapses the grid to a single column on narrow screens", () => {
    const html = render(state({ title: "T", hero: tinyJpeg, body1: "B" }));
    expect(html).toMatch(/@media \(max-width: 600px\)[\s\S]*?\.featured-grid[\s\S]*?grid-template-columns:\s*1fr/);
  });
});
