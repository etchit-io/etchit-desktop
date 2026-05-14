import type { EditorState, ImageValue, SerializeOpts, Template } from "../types";
import { escapeHtml, inlineImageTag, paletteVars, paragraphsToHtml } from "../htmlUtils";

const STEP_COUNT = 4;

function buildSlots() {
  const out: Template["slots"] = [
    { id: "title", kind: "text", placeholder: "How to … (the thing you're teaching)" },
    { id: "intro", kind: "longtext", placeholder: "Intro — what this walks through, who it's for (optional)", optional: true },
  ] as Template["slots"];
  const all = [...out];
  for (let i = 1; i <= STEP_COUNT; i += 1) {
    all.push({
      id: `step-${i}-heading`,
      kind: "text",
      placeholder: `Step ${i} heading`,
      optional: i > 1,
    });
    all.push({
      id: `step-${i}-body`,
      kind: "longtext",
      placeholder: `What to do in step ${i}`,
      optional: i > 1,
    });
    all.push({
      id: `step-${i}-image`,
      kind: "image",
      placeholder: `Drop an image for step ${i} (optional)`,
      optional: true,
    });
  }
  return all;
}

const SLOTS = buildSlots();

function getText(state: EditorState, id: string): string {
  const v = state.slots[id];
  return v && (v.kind === "text" || v.kind === "longtext") ? v.value : "";
}

function getImage(state: EditorState, id: string): ImageValue | null {
  const v = state.slots[id];
  return v && v.kind === "image" ? v.image : null;
}

function step(idx: number, state: EditorState): string {
  const heading = escapeHtml(getText(state, `step-${idx}-heading`).trim());
  const body = paragraphsToHtml(getText(state, `step-${idx}-body`));
  const image = getImage(state, `step-${idx}-image`);
  if (heading.length === 0 && body.length === 0 && !image) return "";
  const imgBlock = image ? `<figure>${inlineImageTag(image, heading)}</figure>` : "";
  const num = idx.toString().padStart(2, "0");
  return `<section class="step">
  <div class="step-num">${num}</div>
  <div class="step-body">
    ${heading.length > 0 ? `<h2>${heading}</h2>` : ""}
    ${body}
    ${imgBlock}
  </div>
</section>`;
}

function render(state: EditorState, opts?: SerializeOpts): string {
  const title = escapeHtml(getText(state, "title").trim());
  const intro = paragraphsToHtml(getText(state, "intro"));
  const steps: string[] = [];
  for (let i = 1; i <= STEP_COUNT; i += 1) {
    const s = step(i, state);
    if (s.length > 0) steps.push(s);
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Space+Grotesk:wght@500;600;700&display=swap" rel="stylesheet">
<style>
  :root { ${paletteVars(opts?.palette)} }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--ink); color: var(--bone); }
  body {
    font-family: 'Inter', system-ui, -apple-system, sans-serif;
    font-size: 16px;
    line-height: 1.65;
    -webkit-font-smoothing: antialiased;
    -webkit-text-size-adjust: 100%;
  }
  .wrap { max-width: 72ch; margin: 0 auto; padding: 36px 24px 96px; }
  h1.title {
    font-family: 'Space Grotesk', system-ui, sans-serif;
    font-weight: 700;
    font-size: clamp(34px, 5vw, 48px);
    line-height: 1.1;
    letter-spacing: -0.02em;
    margin: 0 0 18px;
    color: var(--bone);
  }
  .intro {
    color: var(--ash);
    font-size: 17px;
    margin: 0 0 40px;
    max-width: 60ch;
  }
  .intro p { margin: 0 0 1em; }
  section.step {
    display: grid;
    grid-template-columns: 56px 1fr;
    gap: 18px;
    padding: 24px 0 28px;
    border-top: 1px solid var(--rule);
  }
  section.step .step-num {
    font-family: 'Space Grotesk', sans-serif;
    font-weight: 600;
    font-size: 28px;
    color: var(--copper);
    line-height: 1;
    padding-top: 4px;
  }
  section.step h2 {
    font-family: 'Space Grotesk', sans-serif;
    font-weight: 600;
    font-size: 22px;
    line-height: 1.25;
    margin: 0 0 12px;
    color: var(--bone);
  }
  section.step p {
    margin: 0 0 0.9em;
    word-wrap: break-word;
    overflow-wrap: break-word;
  }
  section.step figure { margin: 18px 0 0; }
  section.step figure img {
    display: block;
    width: 100%;
    height: auto;
    border-radius: 2px;
  }
  ::selection { background: rgba(201,115,43,0.35); color: var(--bone); }
  @media (max-width: 480px) {
    body { font-size: 15px; }
    .wrap { padding: 26px 18px 64px; }
    section.step {
      grid-template-columns: 40px 1fr;
      gap: 12px;
    }
    section.step .step-num { font-size: 22px; }
  }
</style>
</head>
<body>
<div class="wrap">
  <h1 class="title">${title}</h1>
  ${intro.length > 0 ? `<div class="intro">${intro}</div>` : ""}
${steps.join("\n")}
</div>
</body>
</html>
`;
}

export const tutorialTemplate: Template = {
  id: "tutorial",
  name: "Tutorial",
  description: "Numbered steps — heading, body, optional image per step. Up to four steps. Sans-serif and clean.",
  slots: SLOTS,
  serialize: render,
};
