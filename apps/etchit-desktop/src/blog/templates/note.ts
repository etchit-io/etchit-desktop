import type { EditorState, SerializeOpts, Template } from "../types";
import { escapeHtml, paletteVars, paragraphsToHtml } from "../htmlUtils";

const SLOTS = [
  { id: "date", kind: "text" as const, placeholder: "today / Sat 14 May / a date (optional)", optional: true },
  { id: "body", kind: "longtext" as const, placeholder: "Write a short note. Blank lines start a new paragraph." },
];

function getText(state: EditorState, id: string): string {
  const v = state.slots[id];
  return v && (v.kind === "text" || v.kind === "longtext") ? v.value : "";
}

function render(state: EditorState, opts?: SerializeOpts): string {
  const date = escapeHtml(getText(state, "date").trim());
  const body = paragraphsToHtml(getText(state, "body"), `<p class="empty">(empty note)</p>`);
  const dateBlock = date.length > 0 ? `<p class="date">${date}</p>` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${date.length > 0 ? date : "note"}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:ital,wght@0,400;0,500;1,400&display=swap" rel="stylesheet">
<style>
  :root { ${paletteVars(opts?.palette)} }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--ink); color: var(--bone); }
  body {
    font-family: 'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace;
    font-size: 16px;
    line-height: 1.75;
    -webkit-font-smoothing: antialiased;
    -webkit-text-size-adjust: 100%;
  }
  .wrap {
    max-width: 52ch;
    margin: 0 auto;
    padding: 96px 24px 96px;
  }
  p.date {
    font-style: italic;
    font-size: 13px;
    color: var(--ash);
    margin: 0 0 28px;
    letter-spacing: 0.02em;
  }
  article p {
    margin: 0 0 1.2em;
    word-wrap: break-word;
    overflow-wrap: break-word;
  }
  article p.empty { color: var(--ash); font-style: italic; }
  ::selection { background: rgba(201,115,43,0.35); color: var(--bone); }
  @media (max-width: 480px) {
    body { font-size: 15px; }
    .wrap { padding: 56px 18px 56px; }
  }
</style>
</head>
<body>
<div class="wrap">
  ${dateBlock}
  <article>
${body}
  </article>
</div>
</body>
</html>
`;
}

export const noteTemplate: Template = {
  id: "note",
  name: "Note",
  description: "Minimalist micro-post — optional date, body. Just typewriter mono and breathing room.",
  slots: SLOTS,
  serialize: render,
};
