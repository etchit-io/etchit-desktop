import { describe, expect, it } from "vitest";

import { illustratedTemplate } from "./illustrated";
import type { EditorState, ImageValue } from "../types";

const tinyJpeg: ImageValue = {
  dataUrl: "data:image/jpeg;base64,/9j/4AAQSkZJRgABAA==",
  mimeType: "image/jpeg",
  sizeBytes: 42,
  width: 100,
  height: 56,
  originalSizeBytes: 42,
};

function state(s: {
  title?: string;
  hero?: ImageValue | null;
  body1?: string;
  image1?: ImageValue | null;
  caption1?: string;
  body2?: string;
}): EditorState {
  return {
    templateId: "illustrated",
    slots: {
      title: s.title !== undefined ? { kind: "text", value: s.title } : null,
      hero: s.hero !== undefined && s.hero !== null ? { kind: "image", image: s.hero } : null,
      "body-1": s.body1 !== undefined ? { kind: "longtext", value: s.body1 } : null,
      "image-1": s.image1 !== undefined && s.image1 !== null ? { kind: "image", image: s.image1 } : null,
      "caption-1": s.caption1 !== undefined ? { kind: "text", value: s.caption1 } : null,
      "body-2": s.body2 !== undefined ? { kind: "longtext", value: s.body2 } : null,
    },
  };
}

const render = illustratedTemplate.serialize;

describe("illustrated template", () => {
  it("starts with <!DOCTYPE html>", () => {
    expect(render(state({ title: "T", hero: tinyJpeg, body1: "B" })).startsWith("<!DOCTYPE html>")).toBe(true);
  });

  it("contains no literal etchit brand strings", () => {
    const html = render(state({ title: "T", hero: tinyJpeg, body1: "B" })).toLowerCase();
    for (const forbidden of ["etchit", "etch/it", "etch>it", "etchit.io"]) {
      expect(html).not.toContain(forbidden);
    }
  });

  it("inlines the hero image as data: URL", () => {
    const html = render(state({ title: "T", hero: tinyJpeg, body1: "B" }));
    expect(html).toContain(tinyJpeg.dataUrl);
    expect(html).toContain('<figure class="hero">');
  });

  it("omits the inline image block when image-1 is absent", () => {
    const html = render(state({ title: "T", hero: tinyJpeg, body1: "B" }));
    // The hero is one <figure>; an inline image-1 would be a second.
    expect(html.match(/<figure[^>]*>/g)?.length).toBe(1);
  });

  it("emits the inline image with optional caption", () => {
    const html = render(state({
      title: "T",
      hero: tinyJpeg,
      body1: "B",
      image1: tinyJpeg,
      caption1: "a caption",
    }));
    expect(html.match(/<figure[^>]*>/g)?.length).toBe(2);
    expect(html).toContain("<figcaption>a caption</figcaption>");
  });

  it("escapes captions and titles", () => {
    const html = render(state({
      title: "<bad>",
      hero: tinyJpeg,
      body1: "B",
      image1: tinyJpeg,
      caption1: "<x>",
    }));
    expect(html).toContain("&lt;bad&gt;");
    expect(html).toContain("<figcaption>&lt;x&gt;</figcaption>");
  });

  it("splits body paragraphs on blank lines", () => {
    const html = render(state({ title: "T", hero: tinyJpeg, body1: "p1\n\np2" }));
    expect(html.match(/<p>/g)?.length).toBe(2);
  });

  it("emits aspect-ratio 16/9 + object-fit cover for the hero", () => {
    const html = render(state({ title: "T", hero: tinyJpeg, body1: "B" }));
    expect(html).toMatch(/figure\.hero\s*\{[^}]*aspect-ratio:\s*16\s*\/\s*9/);
    expect(html).toMatch(/figure\.hero\s+img\s*\{[^}]*object-fit:\s*cover/);
  });

  it("emits aspect-ratio 3/2 for inline images", () => {
    const html = render(state({
      title: "T",
      hero: tinyJpeg,
      body1: "B",
      image1: tinyJpeg,
    }));
    expect(html).toMatch(/figure\.inline\s*\{[^}]*aspect-ratio:\s*3\s*\/\s*2/);
  });

  it("writes object-position style when the user has shifted the crop", () => {
    const shifted: typeof tinyJpeg = { ...tinyJpeg, objectPosition: { x: 25, y: 75 } };
    const html = render(state({ title: "T", hero: shifted, body1: "B" }));
    expect(html).toMatch(/<img[^>]*style="object-position:\s*25\.0%\s+75\.0%"/);
  });

  it("omits object-position when the crop is centred", () => {
    const html = render(state({ title: "T", hero: tinyJpeg, body1: "B" }));
    expect(html).not.toContain("object-position");
  });

  it("writes transform + transform-origin when the user has zoomed", () => {
    const zoomed: typeof tinyJpeg = { ...tinyJpeg, scale: 2.5 };
    const html = render(state({ title: "T", hero: zoomed, body1: "B" }));
    expect(html).toMatch(/transform:\s*scale\(2\.500\)/);
    expect(html).toMatch(/transform-origin:\s*50\.0%\s+50\.0%/);
  });

  it("combines zoom + pan transform-origin so the focus matches the pan point", () => {
    const both: typeof tinyJpeg = {
      ...tinyJpeg,
      objectPosition: { x: 20, y: 80 },
      scale: 1.6,
    };
    const html = render(state({ title: "T", hero: both, body1: "B" }));
    expect(html).toContain("object-position: 20.0% 80.0%");
    expect(html).toContain("transform: scale(1.600)");
    expect(html).toContain("transform-origin: 20.0% 80.0%");
  });

  it("omits transform when scale is 1 (default)", () => {
    const html = render(state({ title: "T", hero: tinyJpeg, body1: "B" }));
    expect(html).not.toContain("transform: scale");
  });
});
