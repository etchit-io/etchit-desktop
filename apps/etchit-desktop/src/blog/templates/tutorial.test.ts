import { describe, expect, it } from "vitest";

import { tutorialTemplate } from "./tutorial";
import type { EditorState, ImageValue, SlotValue } from "../types";

const tinyPng: ImageValue = {
  dataUrl: "data:image/png;base64,iVBORw0KGgo=",
  mimeType: "image/png",
  sizeBytes: 32,
  width: 1,
  height: 1,
  originalSizeBytes: 32,
};

function state(s: {
  title?: string;
  intro?: string;
  steps?: Array<{ heading?: string; body?: string; image?: ImageValue }>;
}): EditorState {
  const slots: Record<string, SlotValue | null> = {};
  if (s.title !== undefined) slots.title = { kind: "text", value: s.title };
  if (s.intro !== undefined) slots.intro = { kind: "longtext", value: s.intro };
  (s.steps ?? []).forEach((step, idx) => {
    const i = idx + 1;
    slots[`step-${i}-heading`] = step.heading !== undefined ? { kind: "text", value: step.heading } : null;
    slots[`step-${i}-body`] = step.body !== undefined ? { kind: "longtext", value: step.body } : null;
    slots[`step-${i}-image`] = step.image ? { kind: "image", image: step.image } : null;
  });
  return { templateId: "tutorial", slots };
}

const render = tutorialTemplate.serialize;

describe("tutorial template", () => {
  it("starts with <!DOCTYPE html>", () => {
    expect(render(state({ title: "T", steps: [{ heading: "S1", body: "do this" }] })).startsWith("<!DOCTYPE html>")).toBe(true);
  });

  it("contains no literal etchit brand strings", () => {
    const html = render(state({ title: "T", steps: [{ heading: "S", body: "B" }] })).toLowerCase();
    for (const forbidden of ["etchit", "etch/it", "etch>it", "etchit.io"]) {
      expect(html).not.toContain(forbidden);
    }
  });

  it("emits one <section class=\"step\"> per filled step", () => {
    const html = render(state({
      title: "T",
      steps: [
        { heading: "S1", body: "B1" },
        { heading: "S2", body: "B2" },
        { heading: "S3", body: "B3" },
      ],
    }));
    expect(html.match(/<section class="step">/g)?.length).toBe(3);
  });

  it("skips entirely-empty steps", () => {
    const html = render(state({
      title: "T",
      steps: [
        { heading: "S1", body: "B1" },
        {}, // empty
        { heading: "S3", body: "B3" },
      ],
    }));
    expect(html.match(/<section class="step">/g)?.length).toBe(2);
  });

  it("numbers steps as zero-padded two-digit", () => {
    const html = render(state({
      title: "T",
      steps: [
        { heading: "S1", body: "B1" },
        { heading: "S2", body: "B2" },
      ],
    }));
    expect(html).toContain('<div class="step-num">01</div>');
    expect(html).toContain('<div class="step-num">02</div>');
  });

  it("inlines a step image when provided", () => {
    const html = render(state({
      title: "T",
      steps: [{ heading: "S", body: "B", image: tinyPng }],
    }));
    expect(html).toContain(tinyPng.dataUrl);
  });

  it("omits the intro block when empty", () => {
    const html = render(state({ title: "T", steps: [{ heading: "S", body: "B" }] }));
    expect(html).not.toContain('class="intro"');
  });

  it("escapes step headings and bodies", () => {
    const html = render(state({
      title: "T",
      steps: [{ heading: "<bad>", body: "<dangerous>" }],
    }));
    expect(html).toContain("&lt;bad&gt;");
    expect(html).toContain("&lt;dangerous&gt;");
  });
});
