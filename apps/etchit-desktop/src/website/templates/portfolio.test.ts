import { describe, expect, it } from "vitest";

import { portfolioTemplate } from "./portfolio";
import type { ImageValue } from "../../blog/types";
import type { SiteEditorState } from "../types";

const tinyJpeg: ImageValue = {
  dataUrl: "data:image/jpeg;base64,/9j/4AAQ==",
  mimeType: "image/jpeg",
  sizeBytes: 8,
  width: 96,
  height: 64,
  originalSizeBytes: 8,
};

interface Work {
  image?: ImageValue;
  title?: string;
  caption?: string;
}

function state(s: {
  siteName?: string;
  role?: string;
  hero?: ImageValue;
  tagline?: string;
  works?: Work[];
  bio?: string;
  email?: string;
  social?: string;
}): SiteEditorState {
  const gallerySlots: Record<string, { kind: "image" | "text" | "longtext"; value?: string; image?: ImageValue } | null> = {};
  for (let i = 1; i <= 4; i += 1) {
    const w = s.works?.[i - 1];
    gallerySlots[`work-${i}-image`] = w?.image ? { kind: "image", image: w.image } : null;
    gallerySlots[`work-${i}-title`] = w?.title !== undefined ? { kind: "text", value: w.title } : null;
    gallerySlots[`work-${i}-caption`] = w?.caption !== undefined ? { kind: "longtext", value: w.caption } : null;
  }
  return {
    templateId: "portfolio",
    site: {
      siteName: s.siteName !== undefined ? { kind: "text", value: s.siteName } : null,
      role: s.role !== undefined ? { kind: "text", value: s.role } : null,
    },
    pages: {
      home: {
        slots: {
          hero: s.hero ? { kind: "image", image: s.hero } : null,
          tagline: s.tagline !== undefined ? { kind: "text", value: s.tagline } : null,
        },
      },
      gallery: { slots: gallerySlots as never },
      about: { slots: { bio: s.bio !== undefined ? { kind: "longtext", value: s.bio } : null } },
      contact: {
        slots: {
          email: s.email !== undefined ? { kind: "text", value: s.email } : null,
          social: s.social !== undefined ? { kind: "longtext", value: s.social } : null,
        },
      },
    },
  };
}

const render = portfolioTemplate.serialize;

describe("portfolio template", () => {
  it("starts with <!DOCTYPE html>", () => {
    expect(render(state({ siteName: "Jo", tagline: "x" })).startsWith("<!DOCTYPE html>")).toBe(true);
  });

  it("contains no etchit brand strings", () => {
    const html = render(state({ siteName: "Jo", tagline: "x" })).toLowerCase();
    for (const f of ["etchit", "etch/it", "etch>it", "etchit.io"]) {
      expect(html).not.toContain(f);
    }
  });

  it("emits a hash-router script + four page sections", () => {
    const html = render(state({ siteName: "Jo", tagline: "x" }));
    expect(html).toContain("hashchange");
    for (const id of ["home", "gallery", "about", "contact"]) {
      expect(html).toContain(`data-page="${id}"`);
    }
  });

  it("renders only the filled gallery works", () => {
    const html = render(state({
      siteName: "Jo",
      tagline: "x",
      works: [
        { image: tinyJpeg, title: "First" },
        { image: tinyJpeg, title: "Second" },
      ],
    }));
    expect((html.match(/<figure class="work">/g) ?? []).length).toBe(2);
    expect(html).toContain("First");
    expect(html).toContain("Second");
  });

  it("skips entirely-empty work slots between filled ones", () => {
    const html = render(state({
      siteName: "Jo",
      tagline: "x",
      works: [
        { image: tinyJpeg, title: "A" },
        {},
        { image: tinyJpeg, title: "C" },
      ],
    }));
    expect((html.match(/<figure class="work">/g) ?? []).length).toBe(2);
    expect(html).toContain("A");
    expect(html).toContain("C");
  });

  it("includes the role line when set, omits when blank", () => {
    const withRole = render(state({ siteName: "Jo", role: "Photographer", tagline: "x" }));
    expect(withRole).toContain("Photographer");
    const without = render(state({ siteName: "Jo", tagline: "x" }));
    expect(without).not.toContain('class="role"');
  });

  it("emits the email as a clean mailto link", () => {
    const html = render(state({
      siteName: "Jo",
      tagline: "x",
      email: "jo@example.com",
    }));
    expect(html).toContain('href="mailto:jo@example.com"');
  });

  it("falls back to the dark palette by default", () => {
    const html = render(state({ siteName: "Jo", tagline: "x" }));
    expect(html).toContain("--ink: #0a0a0a");
  });
});
