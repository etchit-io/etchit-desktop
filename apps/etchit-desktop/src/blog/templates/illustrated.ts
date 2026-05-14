import type { EditorState, ImageValue, SerializeOpts, Template } from "../types";
import { escapeHtml, inlineImageTag, paletteVars, paragraphsToHtml } from "../htmlUtils";

const SLOTS = [
  { id: "title", kind: "text" as const, placeholder: "Headline" },
  {
    id: "hero",
    kind: "image" as const,
    placeholder: "Drop the hero image here",
    aspect: { width: 16, height: 9 },
  },
  { id: "body-1", kind: "longtext" as const, placeholder: "Opening paragraphs" },
  {
    id: "image-1",
    kind: "image" as const,
    placeholder: "Drop an inline image (optional)",
    aspect: { width: 3, height: 2 },
    optional: true,
  },
  {
    id: "caption-1",
    kind: "text" as const,
    placeholder: "Caption (optional)",
    optional: true,
  },
  {
    id: "body-2",
    kind: "longtext" as const,
    placeholder: "Closing paragraphs (optional)",
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

function figure(image: ImageValue | null, captionText: string, altFallback: string): string {
  if (!image) return "";
  const caption = captionText.trim();
  const captionHtml = caption.length > 0
    ? `<figcaption>${escapeHtml(caption)}</figcaption>`
    : "";
  const alt = caption.length > 0 ? caption : altFallback;
  return `<figure class="inline">${inlineImageTag(image, alt)}${captionHtml}</figure>`;
}

function render(state: EditorState, opts?: SerializeOpts): string {
  const title = escapeHtml(getText(state, "title").trim());
  const hero = getImage(state, "hero");
  const body1 = paragraphsToHtml(getText(state, "body-1"));
  const inline = figure(getImage(state, "image-1"), getText(state, "caption-1"), title);
  const body2 = paragraphsToHtml(getText(state, "body-2"));

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
  .wrap { max-width: 72ch; margin: 0 auto; padding: 28px 22px 80px; }
  h1.title {
    font-family: 'Instrument Serif', Georgia, 'Times New Roman', serif;
    font-style: italic;
    font-weight: 400;
    font-size: clamp(34px, 7vw, 56px);
    line-height: 1.12;
    letter-spacing: -0.01em;
    margin: 0 0 24px;
    color: var(--bone);
  }
  figure { margin: 28px 0; }
  figure.hero { margin: 0 0 28px; aspect-ratio: 16 / 9; overflow: hidden; border-radius: 2px; }
  figure.hero img { display: block; width: 100%; height: 100%; object-fit: cover; }
  figure.inline { aspect-ratio: 3 / 2; overflow: hidden; border-radius: 2px; }
  figure.inline img { display: block; width: 100%; height: 100%; object-fit: cover; }
  figure img { display: block; width: 100%; height: auto; border-radius: 2px; }
  figcaption {
    margin-top: 10px;
    font-size: 13px;
    color: var(--ash);
    line-height: 1.5;
  }
  article p {
    margin: 0 0 1.05em;
    word-wrap: break-word;
    overflow-wrap: break-word;
  }
  ::selection { background: rgba(201,115,43,0.35); color: var(--bone); }
  @media (max-width: 480px) {
    body { font-size: 14.5px; }
    .wrap { padding: 22px 18px 56px; }
  }
</style>
</head>
<body>
<div class="wrap">
  <h1 class="title">${title}</h1>
  ${heroBlock}
  <article>
${body1}
  </article>
  ${inline}
  <article>
${body2}
  </article>
</div>
</body>
</html>
`;
}

export const illustratedTemplate: Template = {
  id: "illustrated",
  name: "Illustrated",
  description: "Hero image up top, then prose. One optional inline image and caption between paragraphs.",
  slots: SLOTS,
  serialize: render,
};
