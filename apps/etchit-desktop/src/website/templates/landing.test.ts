import { describe, expect, it } from "vitest";

import { landingTemplate } from "./landing";
import type { ImageValue } from "../../blog/types";
import type { SiteEditorState } from "../types";

const tinyJpeg: ImageValue = {
  dataUrl: "data:image/jpeg;base64,/9j/4AAQ==",
  mimeType: "image/jpeg",
  sizeBytes: 8,
  width: 192,
  height: 108,
  originalSizeBytes: 8,
};

function state(s: {
  siteName?: string;
  heroHeadline?: string;
  heroSub?: string;
  heroImage?: ImageValue;
  ctaLabel?: string;
  ctaUrl?: string;
  features?: Array<{ title?: string; body?: string }>;
  aboutBody?: string;
}): SiteEditorState {
  const home: Record<string, { kind: "image" | "text" | "longtext"; value?: string; image?: ImageValue } | null> = {
    heroHeadline: s.heroHeadline !== undefined ? { kind: "text", value: s.heroHeadline } : null,
    heroSub: s.heroSub !== undefined ? { kind: "longtext", value: s.heroSub } : null,
    heroImage: s.heroImage ? { kind: "image", image: s.heroImage } : null,
    ctaLabel: s.ctaLabel !== undefined ? { kind: "text", value: s.ctaLabel } : null,
    ctaUrl: s.ctaUrl !== undefined ? { kind: "text", value: s.ctaUrl } : null,
    aboutBody: s.aboutBody !== undefined ? { kind: "longtext", value: s.aboutBody } : null,
  };
  (s.features ?? []).forEach((f, idx) => {
    const i = idx + 1;
    home[`feature${i}Title`] = f.title !== undefined ? { kind: "text", value: f.title } : null;
    home[`feature${i}Body`] = f.body !== undefined ? { kind: "longtext", value: f.body } : null;
  });
  return {
    templateId: "landing",
    site: {
      siteName: s.siteName !== undefined ? { kind: "text", value: s.siteName } : null,
    },
    pages: { home: { slots: home as never } },
  };
}

const render = landingTemplate.serialize;

describe("landing template", () => {
  it("starts with <!DOCTYPE html>", () => {
    expect(render(state({ siteName: "X", heroHeadline: "Big" })).startsWith("<!DOCTYPE html>")).toBe(true);
  });

  it("contains no etchit brand strings", () => {
    const html = render(state({ siteName: "X", heroHeadline: "Big" })).toLowerCase();
    for (const f of ["etchit", "etch/it", "etch>it", "etchit.io"]) {
      expect(html).not.toContain(f);
    }
  });

  it("ships the router script even though there is only one page", () => {
    const html = render(state({ siteName: "X", heroHeadline: "Big" }));
    expect(html).toContain("hashchange");
    expect(html).toContain('data-page="home"');
  });

  it("emits no <nav> because there are no inter-page links", () => {
    const html = render(state({ siteName: "X", heroHeadline: "Big" }));
    expect(html).not.toContain("<nav>");
  });

  it("renders only the filled feature blocks", () => {
    const html = render(state({
      siteName: "X",
      heroHeadline: "Big",
      features: [
        { title: "Fast", body: "very" },
        {},
        { title: "Free", body: "yep" },
      ],
    }));
    expect((html.match(/<div class="feature">/g) ?? []).length).toBe(2);
    expect(html).toContain("Fast");
    expect(html).toContain("Free");
  });

  it("emits a CTA anchor only when both label and URL are set", () => {
    const both = render(state({
      siteName: "X",
      heroHeadline: "Big",
      ctaLabel: "Start",
      ctaUrl: "https://example.com",
    }));
    expect(both).toContain('<a class="cta"');
    expect(both).toContain('href="https://example.com"');

    const onlyLabel = render(state({
      siteName: "X",
      heroHeadline: "Big",
      ctaLabel: "Start",
    }));
    expect(onlyLabel).not.toContain('<a class="cta"');
  });

  it("rejects javascript: in the CTA url", () => {
    const html = render(state({
      siteName: "X",
      heroHeadline: "Big",
      ctaLabel: "Start",
      ctaUrl: "javascript:alert(1)",
    }));
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain('<a class="cta"');
  });

  it("inlines a hero image when supplied", () => {
    const html = render(state({
      siteName: "X",
      heroHeadline: "Big",
      heroImage: tinyJpeg,
    }));
    expect(html).toContain(tinyJpeg.dataUrl);
  });

  it("emits the light palette when requested", () => {
    const html = render(state({ siteName: "X", heroHeadline: "Big" }), { palette: "light" });
    expect(html).toContain("--ink: #f5f2eb");
  });
});
