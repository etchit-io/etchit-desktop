import type { EditorState, SerializeOpts, Template } from "../types";
import { escapeHtml, paletteVars, paragraphsToHtml } from "../htmlUtils";

const SLOTS = [
  { id: "title", kind: "text" as const, placeholder: "Headline" },
  {
    id: "lede",
    kind: "text" as const,
    placeholder: "One-sentence intro (optional)",
    optional: true,
  },
  {
    id: "body",
    kind: "longtext" as const,
    placeholder:
      "Write your post here. Blank lines start a new paragraph; single line breaks collapse into spaces.",
  },
];

function getText(state: EditorState, id: string): string {
  const v = state.slots[id];
  return v && (v.kind === "text" || v.kind === "longtext") ? v.value : "";
}

function render(state: EditorState, opts?: SerializeOpts): string {
  const title = escapeHtml(getText(state, "title").trim());
  const lede = escapeHtml(getText(state, "lede").trim());
  const bodyHtml = paragraphsToHtml(
    getText(state, "body"),
    `<p class="empty">(this post has no body)</p>`,
  );

  const ledeBlock = lede.length > 0 ? `<p class="lede">${lede}</p>` : "";

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
  .wrap { max-width: 62ch; margin: 0 auto; padding: 28px 22px 80px; }
  h1.title {
    font-family: 'Instrument Serif', Georgia, 'Times New Roman', serif;
    font-style: italic;
    font-weight: 400;
    font-size: clamp(34px, 7vw, 52px);
    line-height: 1.12;
    letter-spacing: -0.01em;
    margin: 0 0 14px;
    color: var(--bone);
  }
  p.lede {
    font-family: 'Instrument Serif', Georgia, 'Times New Roman', serif;
    font-style: normal;
    font-size: clamp(18px, 2.4vw, 22px);
    line-height: 1.4;
    color: var(--ash);
    margin: 0 0 26px;
  }
  hr.rule {
    border: 0;
    height: 1px;
    background: var(--copper);
    opacity: 0.7;
    margin: 0 0 28px;
    width: 40px;
  }
  article p {
    margin: 0 0 1.05em;
    word-wrap: break-word;
    overflow-wrap: break-word;
  }
  article p.empty { color: var(--ash); font-style: italic; }
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
  ${ledeBlock}
  <hr class="rule">
  <article>
${bodyHtml}
  </article>
</div>
</body>
</html>
`;
}

export const classicTemplate: Template = {
  id: "classic",
  name: "Classic",
  description: "Title, optional lede, flowing body. Quiet and serif-led — for essays and longer prose.",
  slots: SLOTS,
  serialize: render,
};
