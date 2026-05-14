import type { EditorState, ImageValue, SerializeOpts, Template } from "../types";
import { escapeHtml, inlineImageTag, paletteVars, paragraphsToHtml } from "../htmlUtils";

const PAIR_COUNT = 4;

function buildSlots() {
  const out: Template["slots"] = [
    { id: "title", kind: "text", placeholder: "Headline" },
    { id: "intro", kind: "longtext", placeholder: "Intro paragraph(s)", optional: true },
  ] as Template["slots"];
  const out2 = [...out];
  for (let i = 1; i <= PAIR_COUNT; i += 1) {
    out2.push({
      id: `image-${i}`,
      kind: "image",
      placeholder: `Drop image ${i}`,
      aspect: { width: 3, height: 2 },
      optional: i > 1,
    });
    out2.push({
      id: `caption-${i}`,
      kind: "longtext",
      placeholder: `Caption / paragraph ${i} (optional)`,
      optional: true,
    });
  }
  return out2;
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

function pair(image: ImageValue | null, captionText: string, titleAlt: string): string {
  if (!image) return "";
  const captionHtml = paragraphsToHtml(captionText);
  const alt = captionText.trim().length > 0
    ? captionText.trim().replace(/\s+/g, " ").slice(0, 200)
    : titleAlt;
  return `<section class="pair"><div class="frame">${inlineImageTag(image, alt)}</div>${
    captionHtml.length > 0 ? `<div class="caption">${captionHtml}</div>` : ""
  }</section>`;
}

function render(state: EditorState, opts?: SerializeOpts): string {
  const title = escapeHtml(getText(state, "title").trim());
  const intro = paragraphsToHtml(getText(state, "intro"));
  const pairs: string[] = [];
  for (let i = 1; i <= PAIR_COUNT; i += 1) {
    pairs.push(pair(getImage(state, `image-${i}`), getText(state, `caption-${i}`), title));
  }

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
  .wrap { max-width: 80ch; margin: 0 auto; padding: 28px 22px 80px; }
  h1.title {
    font-family: 'Instrument Serif', Georgia, 'Times New Roman', serif;
    font-style: italic;
    font-weight: 400;
    font-size: clamp(34px, 7vw, 60px);
    line-height: 1.1;
    letter-spacing: -0.01em;
    margin: 0 0 28px;
    color: var(--bone);
  }
  .intro {
    font-family: 'Instrument Serif', Georgia, 'Times New Roman', serif;
    font-style: italic;
    font-size: clamp(17px, 2vw, 20px);
    line-height: 1.5;
    color: var(--ash);
    margin: 0 0 36px;
    max-width: 60ch;
  }
  .intro p { margin: 0 0 0.7em; }
  section.pair { margin: 0 0 48px; }
  section.pair .frame {
    aspect-ratio: 3 / 2;
    overflow: hidden;
    border-radius: 2px;
  }
  section.pair img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .caption {
    margin-top: 14px;
    max-width: 62ch;
    font-size: 14px;
    color: var(--bone);
    line-height: 1.65;
  }
  .caption p { margin: 0 0 0.85em; }
  .caption p:last-child { margin-bottom: 0; }
  ::selection { background: rgba(201,115,43,0.35); color: var(--bone); }
  @media (max-width: 480px) {
    body { font-size: 14.5px; }
    .wrap { padding: 22px 18px 56px; }
    section.pair { margin-bottom: 36px; }
  }
</style>
</head>
<body>
<div class="wrap">
  <h1 class="title">${title}</h1>
  ${intro.length > 0 ? `<div class="intro">${intro}</div>` : ""}
${pairs.filter((p) => p.length > 0).join("\n")}
</div>
</body>
</html>
`;
}

export const photoEssayTemplate: Template = {
  id: "photoEssay",
  name: "Photo essay",
  description: "Title, optional intro, then four image-and-caption blocks down the page. Empty pairs are skipped.",
  slots: SLOTS,
  serialize: render,
};
