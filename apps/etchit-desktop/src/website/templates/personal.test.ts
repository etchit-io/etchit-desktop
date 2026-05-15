import { describe, expect, it } from "vitest";

import { personalTemplate } from "./personal";
import type { ImageValue } from "../../blog/types";
import type { SiteEditorState } from "../types";

const tinyJpeg: ImageValue = {
  dataUrl: "data:image/jpeg;base64,/9j/4AAQ==",
  mimeType: "image/jpeg",
  sizeBytes: 8,
  width: 80,
  height: 80,
  originalSizeBytes: 8,
};

function state(s: {
  siteName?: string;
  avatar?: ImageValue;
  tagline?: string;
  bio?: string;
  nowText?: string;
  links?: string;
}): SiteEditorState {
  return {
    templateId: "personal",
    site: {
      siteName: s.siteName !== undefined ? { kind: "text", value: s.siteName } : null,
    },
    pages: {
      home: {
        slots: {
          avatar: s.avatar ? { kind: "image", image: s.avatar } : null,
          tagline: s.tagline !== undefined ? { kind: "text", value: s.tagline } : null,
        },
      },
      about: {
        slots: { bio: s.bio !== undefined ? { kind: "longtext", value: s.bio } : null },
      },
      now: {
        slots: { nowText: s.nowText !== undefined ? { kind: "longtext", value: s.nowText } : null },
      },
      links: {
        slots: { links: s.links !== undefined ? { kind: "longtext", value: s.links } : null },
      },
    },
  };
}

const render = personalTemplate.serialize;

describe("personal template", () => {
  it("starts with <!DOCTYPE html>", () => {
    expect(render(state({ siteName: "Jo", tagline: "hi" })).startsWith("<!DOCTYPE html>")).toBe(true);
  });

  it("carries no etchit brand strings", () => {
    const html = render(state({ siteName: "Jo", tagline: "hi" })).toLowerCase();
    for (const f of ["etchit", "etch/it", "etch>it", "etchit.io"]) {
      expect(html).not.toContain(f);
    }
  });

  it("includes the router script and a <nav> with all four pages", () => {
    const html = render(state({ siteName: "Jo", tagline: "hi" }));
    expect(html).toContain("hashchange");
    expect((html.match(/data-page="(home|about|now|links)"/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(html).toContain('href="#home"');
    expect(html).toContain('href="#about"');
    expect(html).toContain('href="#now"');
    expect(html).toContain('href="#links"');
  });

  it("emits all four <section data-page=…> blocks", () => {
    const html = render(state({ siteName: "Jo", tagline: "hi" }));
    for (const id of ["home", "about", "now", "links"]) {
      expect(html).toContain(`data-page="${id}"`);
    }
  });

  it("escapes the site name and tagline", () => {
    const html = render(state({ siteName: "<x>", tagline: "<y>" }));
    expect(html).toContain("&lt;x&gt;");
    expect(html).toContain("&lt;y&gt;");
    expect(html).not.toContain("<x>");
  });

  it("inlines the avatar image when provided", () => {
    const html = render(state({ siteName: "Jo", avatar: tinyJpeg, tagline: "hi" }));
    expect(html).toContain(tinyJpeg.dataUrl);
    expect(html).toContain('figure class="avatar"');
  });

  it("parses 'Label | url' links into anchor cards", () => {
    const html = render(state({
      siteName: "Jo",
      tagline: "hi",
      links: "Twitter | https://twitter.com/jo\nGitHub | https://github.com/jo",
    }));
    expect(html).toContain('href="https://twitter.com/jo"');
    expect(html).toContain('href="https://github.com/jo"');
    expect(html).toContain("Twitter");
    expect(html).toContain("GitHub");
    expect((html.match(/<li>/g) ?? []).length).toBe(2);
  });

  it("rejects javascript: URLs in links (replaces with #)", () => {
    const html = render(state({
      siteName: "Jo",
      tagline: "hi",
      links: "Bad | javascript:alert(1)",
    }));
    expect(html).not.toContain("javascript:");
  });

  it("accepts mailto: and autonomi: schemes in links", () => {
    const html = render(state({
      siteName: "Jo",
      tagline: "hi",
      links: "Email | mailto:jo@example.com\nMy site | autonomi://abc",
    }));
    expect(html).toContain('href="mailto:jo@example.com"');
    expect(html).toContain('href="autonomi://abc"');
  });

  it("emits the light palette when requested", () => {
    const html = render(state({ siteName: "Jo", tagline: "hi" }), { palette: "light" });
    expect(html).toContain("--ink: #f5f2eb");
    expect(html).toContain("--bone: #1a1814");
  });

  it("falls back to 'untitled' when siteName is empty", () => {
    const html = render(state({ tagline: "hi", bio: "x" }));
    expect(html).toContain("<title>untitled</title>");
  });
});
