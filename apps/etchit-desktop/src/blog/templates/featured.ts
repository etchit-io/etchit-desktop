import type { EditorState, ImageValue, SerializeOpts, Template } from "../types";
import { escapeHtml, inlineImageTag, paletteVars, paragraphsToHtml } from "../htmlUtils";

const SLOTS = [
  { id: "title", kind: "text" as const, placeholder: "Feature headline" },
  { id: "subtitle", kind: "text" as const, placeholder: "Subtitle (optional)", optional: true },
  {
    id: "hero",
    kind: "image" as const,
    placeholder: "Drop the feature image",
    aspect: { width: 1, height: 1 },
  },
  { id: "body-1", kind: "longtext" as const, placeholder: "Opening paragraphs — flow next to the image" },
  {
    id: "body-2",
    kind: "longtext" as const,
    placeholder: "Continued body (optional, full width below the spread)",
    optional: true,
  },
];

function getText(state: EditorState, id: string): string {
  const v = state.slots[id];
  return v && (v.kind === "text" || v.kind === "longtext") ? v.value : "";
}

function getImage(state: EditorState, id: string): ImageValue | null {
  const v = state.slots[id];
  return v && v.kind === "image" ? v.image : null;
}

function render(state: EditorState, opts?: SerializeOpts): string {
  const title = escapeHtml(getText(state, "title").trim());
  const subtitle = escapeHtml(getText(state, "subtitle").trim());
  const hero = getImage(state, "hero");
  const body1 = paragraphsToHtml(getText(state, "body-1"));
  const body2 = paragraphsToHtml(getText(state, "body-2"));

  const subtitleBlock = subtitle.length > 0 ? `<p class="subtitle">${subtitle}</p>` : "";
  const heroBlock = hero ? `<figure class="hero">${inlineImageTag(hero, title)}</figure>` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root { ${paletteVars(opts?.palette)} }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--ink); color: var(--bone); }
  body {
    font-family: 'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace;
    font-size: 15px;
    line-height: 1.7;
    -webkit-font-smoothing: antialiased;
    -webkit-text-size-adjust: 100%;
  }
  .wrap { max-width: 76ch; margin: 0 auto; padding: 36px 24px 96px; }
  h1.title {
    font-family: 'Instrument Serif', Georgia, 'Times New Roman', serif;
    font-style: italic;
    font-weight: 400;
    font-size: clamp(34px, 6vw, 54px);
    line-height: 1.1;
    letter-spacing: -0.01em;
    margin: 0 0 14px;
    color: var(--bone);
  }
  p.subtitle {
    font-family: 'Instrument Serif', Georgia, serif;
    font-size: clamp(18px, 2vw, 22px);
    line-height: 1.4;
    color: var(--ash);
    margin: 0 0 28px;
  }
  .featured-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 28px;
    margin: 0 0 32px;
    align-items: start;
  }
  figure.hero {
    aspect-ratio: 1 / 1;
    overflow: hidden;
    border-radius: 2px;
    margin: 0;
  }
  figure.hero img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .side-text p,
  article p {
    margin: 0 0 1.05em;
    word-wrap: break-word;
    overflow-wrap: break-word;
  }
  ::selection { background: rgba(201,115,43,0.35); color: var(--bone); }
  @media (max-width: 600px) {
    .featured-grid { grid-template-columns: 1fr; }
  }
  @media (max-width: 480px) {
    body { font-size: 14.5px; }
    .wrap { padding: 26px 18px 64px; }
  }
</style>
</head>
<body>
<div class="wrap">
  <h1 class="title">${title}</h1>
  ${subtitleBlock}
  <div class="featured-grid">
    ${heroBlock}
    <div class="side-text">${body1}</div>
  </div>
  <article>${body2}</article>
</div>
</body>
</html>
`;
}

function layoutEditor(slots: Record<string, HTMLElement>, container: HTMLElement): void {
  container.innerHTML = "";
  container.appendChild(slots.title);
  container.appendChild(slots.subtitle);

  const grid = document.createElement("div");
  grid.className = "featured-grid";
  grid.appendChild(slots.hero);
  const sideText = document.createElement("div");
  sideText.className = "side-text";
  sideText.appendChild(slots["body-1"]);
  grid.appendChild(sideText);
  container.appendChild(grid);

  container.appendChild(slots["body-2"]);
}

export const featuredTemplate: Template = {
  id: "featured",
  name: "Featured",
  description:
    "Magazine feature — a 1:1 square hero on the left, opening paragraph flowing next to it on the right, body below.",
  slots: SLOTS,
  serialize: render,
  layoutEditor,
};
