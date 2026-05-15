import type { ImageValue, SerializeOpts, Slot } from "../../blog/types";
import { escapeHtml, inlineImageTag, isDangerousUrl, isSafeUrl, normaliseUrl, paletteVars, paragraphsToHtml } from "../../blog/htmlUtils";
import { navHtml, routerScript } from "../router";
import type { Page, SiteEditorState, SiteTemplate } from "../types";

const SITE_SLOTS: readonly Slot[] = [
  { id: "siteName", kind: "text", placeholder: "Your name or handle" },
];

const PAGES: readonly Page[] = [
  {
    id: "home",
    name: "Home",
    slots: [
      {
        id: "avatar",
        kind: "image",
        placeholder: "Drop a square portrait (optional)",
        aspect: { width: 1, height: 1 },
        optional: true,
      },
      { id: "tagline", kind: "text", placeholder: "One-line about you" },
    ],
  },
  {
    id: "about",
    name: "About",
    slots: [{ id: "bio", kind: "longtext", placeholder: "Your bio in any length" }],
  },
  {
    id: "now",
    name: "Now",
    slots: [
      {
        id: "nowText",
        kind: "longtext",
        placeholder: "What you're working on right now (optional)",
        optional: true,
      },
    ],
  },
  {
    id: "links",
    name: "Links",
    slots: [
      {
        id: "links",
        kind: "longtext",
        placeholder:
          "One per line. Format: 'Label | value'.\nExamples:\nMy other site | <64-hex Autonomi address>\nEmail | you@example.com\n(clearnet links like twitter.com show as text — fetch>it is Autonomi-only)",
      },
    ],
  },
];

function siteText(state: SiteEditorState, id: string): string {
  const v = state.site[id];
  return v && (v.kind === "text" || v.kind === "longtext") ? v.value : "";
}
function pageText(state: SiteEditorState, pageId: string, slotId: string): string {
  const v = state.pages[pageId]?.slots[slotId];
  return v && (v.kind === "text" || v.kind === "longtext") ? v.value : "";
}
function pageImage(state: SiteEditorState, pageId: string, slotId: string): ImageValue | null {
  const v = state.pages[pageId]?.slots[slotId];
  return v && v.kind === "image" ? v.image : null;
}

function parseLinks(text: string): Array<{ label: string; url: string; raw: string }> {
  const out: Array<{ label: string; url: string; raw: string }> = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const sep = line.includes("|") ? "|" : line.includes(": ") ? ":" : null;
    let label = line;
    let value = line;
    if (sep) {
      const idx = line.indexOf(sep);
      label = line.slice(0, idx).trim();
      value = line.slice(idx + 1).trim();
      if (value.length === 0) value = label;
    }
    // Drop dangerous entries entirely so the raw `javascript:` / `data:`
    // content never even appears as visible text in the rendered page.
    if (isDangerousUrl(value) || isDangerousUrl(label)) continue;
    out.push({ label, url: normaliseUrl(value), raw: value });
  }
  return out;
}

function render(state: SiteEditorState, opts?: SerializeOpts): string {
  const siteName = escapeHtml(siteText(state, "siteName").trim()) || "untitled";
  const avatar = pageImage(state, "home", "avatar");
  const tagline = escapeHtml(pageText(state, "home", "tagline").trim());
  const bio = paragraphsToHtml(pageText(state, "about", "bio"));
  const nowText = paragraphsToHtml(pageText(state, "now", "nowText"));
  const links = parseLinks(pageText(state, "links", "links"));

  const linksHtml = links.length > 0
    ? `<ul class="links">${links
        .map((l) => {
          if (l.url.length > 0 && isSafeUrl(l.url)) {
            return `<li><a href="${escapeHtml(l.url)}" target="_blank" rel="noopener noreferrer"><span class="label">${escapeHtml(l.label)}</span><span class="arrow">→</span></a></li>`;
          }
          // Not linkable from fetch>it — render as text, keep the value visible.
          const valueText = l.raw !== l.label ? `<span class="value">${escapeHtml(l.raw)}</span>` : "";
          return `<li class="text"><span class="label">${escapeHtml(l.label)}</span>${valueText}</li>`;
        })
        .join("")}</ul>`
    : `<p class="empty">(no links yet)</p>`;

  const avatarBlock = avatar
    ? `<figure class="avatar">${inlineImageTag(avatar, siteName)}</figure>`
    : "";

  const homeSection = `
<section data-page="home">
  ${avatarBlock}
  <h2 class="name">${siteName}</h2>
  ${tagline.length > 0 ? `<p class="tagline">${tagline}</p>` : ""}
</section>`;

  const aboutSection = `
<section data-page="about" hidden>
  <h2>About</h2>
  <article>${bio}</article>
</section>`;

  const nowSection = `
<section data-page="now" hidden>
  <h2>Now</h2>
  <article>${nowText.length > 0 ? nowText : '<p class="empty">(nothing here yet)</p>'}</article>
</section>`;

  const linksSection = `
<section data-page="links" hidden>
  <h2>Links</h2>
  ${linksHtml}
</section>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${siteName}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Source+Serif+Pro:ital,wght@0,400;0,600;1,400&display=swap" rel="stylesheet">
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
  .layout {
    display: grid;
    grid-template-columns: 240px 1fr;
    gap: 0;
    min-height: 100vh;
  }
  aside.sidebar {
    padding: 56px 28px 32px;
    border-right: 1px solid var(--rule);
    position: sticky;
    top: 0;
    height: 100vh;
    align-self: start;
  }
  h1.brand {
    font-family: 'Instrument Serif', Georgia, serif;
    font-style: italic;
    font-weight: 400;
    font-size: 28px;
    line-height: 1.1;
    margin: 0 0 32px;
    color: var(--bone);
    letter-spacing: -0.01em;
  }
  nav { display: flex; flex-direction: column; gap: 4px; }
  nav a {
    color: var(--ash);
    text-decoration: none;
    font-size: 15px;
    padding: 6px 0;
    transition: color 120ms ease, padding-left 140ms ease;
  }
  nav a:hover { color: var(--bone); }
  nav a.current {
    color: var(--copper);
    padding-left: 10px;
    border-left: 2px solid var(--copper);
    margin-left: -12px;
  }
  main {
    padding: 80px 64px 96px;
    max-width: 68ch;
  }
  main section { display: block; }
  main section[hidden] { display: none; }
  figure.avatar {
    margin: 0 0 28px;
    width: 160px;
    aspect-ratio: 1 / 1;
    border-radius: 50%;
    overflow: hidden;
  }
  figure.avatar img { display: block; width: 100%; height: 100%; object-fit: cover; }
  h2.name {
    font-family: 'Instrument Serif', Georgia, serif;
    font-style: italic;
    font-weight: 400;
    font-size: clamp(36px, 5vw, 56px);
    line-height: 1.1;
    letter-spacing: -0.01em;
    margin: 0 0 14px;
    color: var(--bone);
  }
  p.tagline {
    font-family: 'Instrument Serif', Georgia, serif;
    font-size: clamp(20px, 2.4vw, 26px);
    line-height: 1.4;
    color: var(--ash);
    margin: 0;
  }
  main section h2 {
    font-family: 'Instrument Serif', Georgia, serif;
    font-style: italic;
    font-weight: 400;
    font-size: clamp(28px, 4vw, 40px);
    line-height: 1.1;
    letter-spacing: -0.01em;
    margin: 0 0 24px;
    color: var(--bone);
  }
  article p {
    margin: 0 0 1.05em;
    word-wrap: break-word;
    overflow-wrap: break-word;
  }
  article p.empty,
  p.empty { color: var(--ash); font-style: italic; }
  ul.links {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
    border-top: 1px solid var(--rule);
  }
  ul.links li { border-bottom: 1px solid var(--rule); }
  ul.links a {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 16px 0;
    color: var(--bone);
    text-decoration: none;
    transition: color 120ms ease, padding-left 140ms ease;
  }
  ul.links a:hover {
    color: var(--copper);
    padding-left: 8px;
  }
  ul.links .arrow { color: var(--copper); font-size: 18px; }
  ul.links li.text {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 16px 0;
    color: var(--bone);
    gap: 12px;
  }
  ul.links li.text .value { color: var(--ash); font-size: 14px; font-style: italic; }
  ::selection { background: color-mix(in srgb, var(--copper) 35%, transparent); color: var(--bone); }
  @media (max-width: 720px) {
    .layout { grid-template-columns: 1fr; }
    aside.sidebar {
      position: static;
      height: auto;
      padding: 32px 24px 16px;
      border-right: 0;
      border-bottom: 1px solid var(--rule);
    }
    nav { flex-direction: row; flex-wrap: wrap; gap: 12px 18px; }
    nav a.current { padding-left: 0; border-left: 0; margin-left: 0; border-bottom: 2px solid var(--copper); }
    main { padding: 40px 24px 56px; }
  }
</style>
</head>
<body>
<div class="layout">
  <aside class="sidebar">
    <h1 class="brand">${siteName}</h1>
    ${navHtml(PAGES)}
  </aside>
  <main>
    ${homeSection}
    ${aboutSection}
    ${nowSection}
    ${linksSection}
  </main>
</div>
${routerScript()}
</body>
</html>
`;
}

export const personalTemplate: SiteTemplate = {
  id: "personal",
  name: "Personal Site",
  description: "Home, About, Now, Links — sidebar-nav layout with serif typography. The classic indie-web personal site.",
  siteSlots: SITE_SLOTS,
  pages: PAGES,
  serialize: render,
};
