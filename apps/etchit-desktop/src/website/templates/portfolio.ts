import type { ImageValue, SerializeOpts, Slot } from "../../blog/types";
import { escapeHtml, inlineImageTag, isDangerousUrl, isSafeUrl, normaliseUrl, paletteVars, paragraphsToHtml } from "../../blog/htmlUtils";
import { navHtml, routerScript } from "../router";
import type { Page, SiteEditorState, SiteTemplate } from "../types";

const SITE_SLOTS: readonly Slot[] = [
  { id: "siteName", kind: "text", placeholder: "Your name" },
  { id: "role", kind: "text", placeholder: "What you do (photographer, designer, …)", optional: true },
];

const WORK_COUNT = 4;

function buildPages(): readonly Page[] {
  const gallerySlots: Slot[] = [];
  for (let i = 1; i <= WORK_COUNT; i += 1) {
    gallerySlots.push({
      id: `work-${i}-image`,
      kind: "image",
      placeholder: `Work ${i} — drop image`,
      aspect: { width: 3, height: 2 },
      optional: i > 1,
    });
    gallerySlots.push({
      id: `work-${i}-title`,
      kind: "text",
      placeholder: `Work ${i} title (optional)`,
      optional: true,
    });
    gallerySlots.push({
      id: `work-${i}-caption`,
      kind: "longtext",
      placeholder: `Work ${i} description (optional)`,
      optional: true,
    });
  }
  return [
    {
      id: "home",
      name: "Home",
      slots: [
        {
          id: "hero",
          kind: "image",
          placeholder: "Drop a hero image (optional)",
          aspect: { width: 16, height: 9 },
          optional: true,
        },
        { id: "tagline", kind: "text", placeholder: "A line about your work" },
      ],
    },
    { id: "gallery", name: "Gallery", slots: gallerySlots },
    {
      id: "about",
      name: "About",
      slots: [{ id: "bio", kind: "longtext", placeholder: "Your story" }],
    },
    {
      id: "contact",
      name: "Contact",
      slots: [
        { id: "email", kind: "text", placeholder: "you@example.com (optional)", optional: true },
        {
          id: "social",
          kind: "longtext",
          placeholder:
            "Social handles, one per line. 'Label | value'.\nautonomi:// addresses and emails become links; clearnet shows as text.",
          optional: true,
        },
      ],
    },
  ];
}

const PAGES = buildPages();

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
    if (isDangerousUrl(value) || isDangerousUrl(label)) continue;
    out.push({ label, url: normaliseUrl(value), raw: value });
  }
  return out;
}

function render(state: SiteEditorState, opts?: SerializeOpts): string {
  const siteName = escapeHtml(siteText(state, "siteName").trim()) || "untitled";
  const role = escapeHtml(siteText(state, "role").trim());
  const hero = pageImage(state, "home", "hero");
  const tagline = escapeHtml(pageText(state, "home", "tagline").trim());

  const works: string[] = [];
  for (let i = 1; i <= WORK_COUNT; i += 1) {
    const img = pageImage(state, "gallery", `work-${i}-image`);
    if (!img) continue;
    const wTitle = escapeHtml(pageText(state, "gallery", `work-${i}-title`).trim());
    const wCap = paragraphsToHtml(pageText(state, "gallery", `work-${i}-caption`));
    works.push(`
<figure class="work">
  <div class="frame">${inlineImageTag(img, wTitle || siteName)}</div>
  ${wTitle.length > 0 ? `<figcaption><h3>${wTitle}</h3>${wCap}</figcaption>` : wCap.length > 0 ? `<figcaption>${wCap}</figcaption>` : ""}
</figure>`);
  }

  const bio = paragraphsToHtml(pageText(state, "about", "bio"));
  const email = escapeHtml(pageText(state, "contact", "email").trim());
  const social = parseLinks(pageText(state, "contact", "social"));

  const socialHtml = social.length > 0
    ? `<ul class="social">${social
        .map((s) => {
          if (s.url.length > 0 && isSafeUrl(s.url)) {
            return `<li><a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(s.label)}</a></li>`;
          }
          const valueText = s.raw !== s.label ? ` <span class="value">${escapeHtml(s.raw)}</span>` : "";
          return `<li class="text">${escapeHtml(s.label)}${valueText}</li>`;
        })
        .join("")}</ul>`
    : "";

  const homeSection = `
<section data-page="home">
  ${hero ? `<figure class="hero">${inlineImageTag(hero, siteName)}</figure>` : ""}
  <h2 class="display">${siteName}</h2>
  ${role.length > 0 ? `<p class="role">${role}</p>` : ""}
  ${tagline.length > 0 ? `<p class="tagline">${tagline}</p>` : ""}
</section>`;

  const gallerySection = `
<section data-page="gallery" hidden>
  <h2>Selected work</h2>
  ${works.length > 0 ? works.join("\n") : '<p class="empty">(no works yet)</p>'}
</section>`;

  const aboutSection = `
<section data-page="about" hidden>
  <h2>About</h2>
  <article>${bio}</article>
</section>`;

  const contactSection = `
<section data-page="contact" hidden>
  <h2>Contact</h2>
  ${email.length > 0 ? `<p class="email"><a href="${escapeHtml(normaliseUrl(email))}">${email}</a></p>` : ""}
  ${socialHtml}
</section>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${siteName}${role.length > 0 ? ` — ${role}` : ""}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,500;0,700;1,500&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
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
  header.topbar {
    position: sticky;
    top: 0;
    z-index: 10;
    background: color-mix(in srgb, var(--ink) 92%, transparent);
    backdrop-filter: blur(8px);
    border-bottom: 1px solid var(--rule);
    padding: 16px 36px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 24px;
  }
  header.topbar .brand {
    font-family: 'Playfair Display', Georgia, serif;
    font-weight: 700;
    font-size: 18px;
    letter-spacing: -0.01em;
    color: var(--bone);
  }
  header.topbar nav { display: flex; gap: 24px; }
  header.topbar nav a {
    color: var(--ash);
    text-decoration: none;
    font-size: 14px;
    font-weight: 500;
    letter-spacing: 0.02em;
    transition: color 120ms ease;
  }
  header.topbar nav a:hover { color: var(--bone); }
  header.topbar nav a.current { color: var(--copper); }
  main { padding: 48px 36px 96px; max-width: 84ch; margin: 0 auto; }
  main section { display: block; }
  main section[hidden] { display: none; }
  figure.hero {
    margin: 0 0 36px;
    aspect-ratio: 16 / 9;
    overflow: hidden;
    border-radius: 2px;
  }
  figure.hero img { display: block; width: 100%; height: 100%; object-fit: cover; }
  h2.display {
    font-family: 'Playfair Display', Georgia, serif;
    font-weight: 700;
    font-size: clamp(40px, 6vw, 64px);
    line-height: 1.05;
    letter-spacing: -0.02em;
    margin: 0 0 12px;
    color: var(--bone);
  }
  p.role {
    font-family: 'Playfair Display', Georgia, serif;
    font-style: italic;
    font-weight: 500;
    font-size: clamp(18px, 2.2vw, 22px);
    color: var(--copper);
    margin: 0 0 18px;
  }
  p.tagline {
    font-size: clamp(17px, 1.8vw, 19px);
    color: var(--ash);
    margin: 0;
    max-width: 60ch;
  }
  main section h2 {
    font-family: 'Playfair Display', Georgia, serif;
    font-weight: 700;
    font-size: clamp(28px, 4vw, 40px);
    line-height: 1.1;
    letter-spacing: -0.015em;
    margin: 0 0 32px;
    color: var(--bone);
  }
  figure.work {
    margin: 0 0 56px;
  }
  figure.work .frame {
    aspect-ratio: 3 / 2;
    overflow: hidden;
    border-radius: 2px;
  }
  figure.work img { display: block; width: 100%; height: 100%; object-fit: cover; }
  figure.work figcaption {
    margin-top: 18px;
    max-width: 62ch;
  }
  figure.work figcaption h3 {
    font-family: 'Playfair Display', Georgia, serif;
    font-weight: 600;
    font-size: 22px;
    line-height: 1.2;
    margin: 0 0 8px;
    color: var(--bone);
  }
  figure.work figcaption p {
    margin: 0 0 0.8em;
    color: var(--bone);
    font-size: 15px;
    line-height: 1.65;
  }
  article p {
    margin: 0 0 1.1em;
    word-wrap: break-word;
    overflow-wrap: break-word;
  }
  p.email {
    font-family: 'Playfair Display', Georgia, serif;
    font-style: italic;
    font-size: clamp(22px, 3vw, 30px);
    margin: 0 0 32px;
  }
  p.email a { color: var(--copper); text-decoration: none; }
  p.email a:hover { color: var(--bone); }
  ul.social { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  ul.social a {
    color: var(--bone);
    text-decoration: none;
    border-bottom: 1px solid var(--rule);
    padding: 12px 0;
    display: block;
    transition: color 120ms ease;
  }
  ul.social a:hover { color: var(--copper); }
  ul.social li.text {
    color: var(--bone);
    padding: 12px 0;
    border-bottom: 1px solid var(--rule);
    display: block;
  }
  ul.social li.text .value { color: var(--ash); font-style: italic; font-size: 14px; margin-left: 8px; }
  p.empty { color: var(--ash); font-style: italic; }
  ::selection { background: color-mix(in srgb, var(--copper) 35%, transparent); color: var(--bone); }
  @media (max-width: 600px) {
    header.topbar { padding: 14px 20px; gap: 12px; }
    header.topbar nav { gap: 14px; }
    main { padding: 32px 20px 56px; }
  }
</style>
</head>
<body>
<header class="topbar">
  <span class="brand">${siteName}</span>
  ${navHtml(PAGES)}
</header>
<main>
  ${homeSection}
  ${gallerySection}
  ${aboutSection}
  ${contactSection}
</main>
${routerScript()}
</body>
</html>
`;
}

export const portfolioTemplate: SiteTemplate = {
  id: "portfolio",
  name: "Portfolio",
  description: "Top nav, image-forward gallery, large display serif. For photographers, designers, anyone showing work.",
  siteSlots: SITE_SLOTS,
  pages: PAGES,
  serialize: render,
};
