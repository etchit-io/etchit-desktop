import type { EditorState, ImageValue, SerializeOpts, Template } from "../types";
import { escapeHtml, inlineImageTag, paletteVars, paragraphsToHtml } from "../htmlUtils";

const SLOTS = [
  { id: "title", kind: "text" as const, placeholder: "Headline" },
  { id: "subtitle", kind: "text" as const, placeholder: "Subtitle (optional)", optional: true },
  { id: "byline", kind: "text" as const, placeholder: "By Author · 14 May 2026 (optional)", optional: true },
  {
    id: "hero",
    kind: "image" as const,
    placeholder: "Drop hero image (optional)",
    aspect: { width: 16, height: 9 },
    optional: true,
  },
  { id: "body-1", kind: "longtext" as const, placeholder: "Opening paragraphs" },
  { id: "pullquote", kind: "longtext" as const, placeholder: "A short standout quote (optional)", optional: true },
  { id: "body-2", kind: "longtext" as const, placeholder: "Closing paragraphs (optional)", optional: true },
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
  const byline = escapeHtml(getText(state, "byline").trim());
  const hero = getImage(state, "hero");
  const body1 = paragraphsToHtml(getText(state, "body-1"));
  const pullquote = getText(state, "pullquote").trim();
  const body2 = paragraphsToHtml(getText(state, "body-2"));

  const subtitleBlock = subtitle.length > 0 ? `<p class="subtitle">${subtitle}</p>` : "";
  const bylineBlock = byline.length > 0 ? `<p class="byline">${byline}</p>` : "";
  const heroBlock = hero ? `<figure class="hero">${inlineImageTag(hero, title)}</figure>` : "";
  const pullBlock = pullquote.length > 0
    ? `<blockquote class="pull">${escapeHtml(pullquote.replace(/\s+/g, " "))}</blockquote>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,500;0,700;1,500&family=Source+Serif+Pro:ital,wght@0,400;0,600;1,400&display=swap" rel="stylesheet">
<style>
  :root { ${paletteVars(opts?.palette)} }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--ink); color: var(--bone); }
  body {
    font-family: 'Source Serif Pro', Georgia, 'Times New Roman', serif;
    font-size: 17px;
    line-height: 1.65;
    -webkit-font-smoothing: antialiased;
    -webkit-text-size-adjust: 100%;
  }
  .wrap { max-width: 68ch; margin: 0 auto; padding: 36px 22px 96px; }
  h1.title {
    font-family: 'Playfair Display', Georgia, 'Times New Roman', serif;
    font-weight: 700;
    font-size: clamp(38px, 6vw, 58px);
    line-height: 1.08;
    letter-spacing: -0.015em;
    margin: 0 0 14px;
    color: var(--bone);
  }
  p.subtitle {
    font-family: 'Playfair Display', Georgia, serif;
    font-style: italic;
    font-weight: 500;
    font-size: clamp(18px, 2.2vw, 22px);
    line-height: 1.35;
    color: var(--ash);
    margin: 0 0 18px;
  }
  p.byline {
    font-style: italic;
    font-size: 14px;
    color: var(--ash);
    margin: 0 0 28px;
    letter-spacing: 0.01em;
  }
  figure.hero { margin: 0 0 32px; aspect-ratio: 16 / 9; overflow: hidden; border-radius: 2px; }
  figure.hero img { display: block; width: 100%; height: 100%; object-fit: cover; }
  article p { margin: 0 0 1.05em; word-wrap: break-word; overflow-wrap: break-word; }
  blockquote.pull {
    font-family: 'Playfair Display', Georgia, serif;
    font-style: italic;
    font-weight: 500;
    font-size: clamp(22px, 3vw, 30px);
    line-height: 1.35;
    color: var(--bone);
    margin: 32px 0;
    padding: 18px 0;
    border-top: 1px solid var(--copper);
    border-bottom: 1px solid var(--copper);
    text-align: center;
  }
  ::selection { background: rgba(201,115,43,0.35); color: var(--bone); }
  @media (max-width: 480px) {
    body { font-size: 16px; }
    .wrap { padding: 26px 18px 64px; }
  }
</style>
</head>
<body>
<div class="wrap">
  <h1 class="title">${title}</h1>
  ${subtitleBlock}
  ${bylineBlock}
  ${heroBlock}
  <article>
${body1}
  </article>
  ${pullBlock}
  <article>
${body2}
  </article>
</div>
</body>
</html>
`;
}

export const articleTemplate: Template = {
  id: "article",
  name: "Article",
  description: "Magazine layout — display serif title, subtitle, byline, hero image, optional pull-quote between sections.",
  slots: SLOTS,
  serialize: render,
};
