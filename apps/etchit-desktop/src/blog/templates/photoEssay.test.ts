import { describe, expect, it } from "vitest";

import { photoEssayTemplate } from "./photoEssay";
import type { EditorState, ImageValue, SlotValue } from "../types";

const tinyPng: ImageValue = {
  dataUrl: "data:image/png;base64,iVBORw0KGgo=",
  mimeType: "image/png",
  sizeBytes: 32,
  width: 80,
  height: 53,
  originalSizeBytes: 32,
};

function state(s: {
  title?: string;
  intro?: string;
  pairs?: Array<{ image?: ImageValue; caption?: string }>;
}): EditorState {
  const slots: Record<string, SlotValue | null> = {};
  if (s.title !== undefined) slots.title = { kind: "text", value: s.title };
  if (s.intro !== undefined) slots.intro = { kind: "longtext", value: s.intro };
  (s.pairs ?? []).forEach((p, idx) => {
    const i = idx + 1;
    slots[`image-${i}`] = p.image ? { kind: "image", image: p.image } : null;
    slots[`caption-${i}`] = p.caption !== undefined ? { kind: "longtext", value: p.caption } : null;
  });
  return { templateId: "photoEssay", slots };
}

const render = photoEssayTemplate.serialize;

describe("photoEssay template", () => {
  it("starts with <!DOCTYPE html>", () => {
    expect(render(state({ title: "T", pairs: [{ image: tinyPng }] })).startsWith("<!DOCTYPE html>")).toBe(true);
  });

  it("contains no literal etchit brand strings", () => {
    const html = render(state({ title: "T", pairs: [{ image: tinyPng }] })).toLowerCase();
    for (const forbidden of ["etchit", "etch/it", "etch>it", "etchit.io"]) {
      expect(html).not.toContain(forbidden);
    }
  });

  it("emits one <section class=\"pair\"> per filled image slot", () => {
    const html = render(state({
      title: "T",
      pairs: [
        { image: tinyPng, caption: "one" },
        { image: tinyPng, caption: "two" },
      ],
    }));
    expect(html.match(/<section class="pair">/g)?.length).toBe(2);
  });

  it("skips empty image slots", () => {
    const html = render(state({
      title: "T",
      pairs: [
        { image: tinyPng, caption: "one" },
        {}, // empty
        { image: tinyPng, caption: "three" },
      ],
    }));
    expect(html.match(/<section class="pair">/g)?.length).toBe(2);
    expect(html).toContain("one");
    expect(html).toContain("three");
  });

  it("omits the intro block when intro is empty", () => {
    const html = render(state({ title: "T", pairs: [{ image: tinyPng }] }));
    expect(html).not.toContain('<div class="intro">');
  });

  it("emits the intro when it has content", () => {
    const html = render(state({
      title: "T",
      intro: "an opening line\n\nand a second paragraph",
      pairs: [{ image: tinyPng }],
    }));
    expect(html).toContain('<div class="intro">');
    expect(html.match(/<p>/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("escapes captions", () => {
    const html = render(state({
      title: "T",
      pairs: [{ image: tinyPng, caption: "<dangerous>" }],
    }));
    expect(html).toContain("&lt;dangerous&gt;");
    expect(html).not.toContain("<dangerous>");
  });

  it("inlines image data: URLs", () => {
    const html = render(state({ title: "T", pairs: [{ image: tinyPng }] }));
    expect(html).toContain(tinyPng.dataUrl);
  });

  it("emits aspect-ratio 3/2 frames so all pairs share the same crop", () => {
    const html = render(state({ title: "T", pairs: [{ image: tinyPng }] }));
    expect(html).toMatch(/section\.pair\s+\.frame\s*\{[^}]*aspect-ratio:\s*3\s*\/\s*2/);
    expect(html).toMatch(/section\.pair\s+img\s*\{[^}]*object-fit:\s*cover/);
    expect(html).toContain('<div class="frame">');
  });
});
