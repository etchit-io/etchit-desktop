import type { ImageValue, SerializeOpts, Slot } from "../../blog/types";
import { escapeHtml, inlineImageTag, isSafeUrl, normaliseUrl, paletteVars, paragraphsToHtml } from "../../blog/htmlUtils";
import { routerScript } from "../router";
import type { Page, SiteEditorState, SiteTemplate } from "../types";

const SITE_SLOTS: readonly Slot[] = [
  { id: "siteName", kind: "text", placeholder: "Project / product name" },
];

const PAGE_SLOTS: readonly Slot[] = [
  { id: "heroHeadline", kind: "text", placeholder: "A bold one-line headline" },
  { id: "heroSub", kind: "longtext", placeholder: "Subhead — what is this for? (optional)", optional: true },
  {
    id: "heroImage",
    kind: "image",
    placeholder: "Drop a hero image (16:9, optional)",
    aspect: { width: 16, height: 9 },
    optional: true,
  },
  { id: "ctaLabel", kind: "text", placeholder: "Button label (e.g. 'Get started')", optional: true },
  {
    id: "ctaUrl",
    kind: "text",
    placeholder: "Where the button goes — autonomi:// address, 64-hex, or mailto: (fetch>it is Autonomi-only)",
    optional: true,
  },
  { id: "feature1Title", kind: "text", placeholder: "Feature 1 title", optional: true },
  { id: "feature1Body", kind: "longtext", placeholder: "Feature 1 body", optional: true },
  { id: "feature2Title", kind: "text", placeholder: "Feature 2 title", optional: true },
  { id: "feature2Body", kind: "longtext", placeholder: "Feature 2 body", optional: true },
  { id: "feature3Title", kind: "text", placeholder: "Feature 3 title", optional: true },
  { id: "feature3Body", kind: "longtext", placeholder: "Feature 3 body", optional: true },
  { id: "aboutBody", kind: "longtext", placeholder: "More about the project (optional)", optional: true },
];

const PAGES: readonly Page[] = [{ id: "home", name: "Home", slots: PAGE_SLOTS }];

function siteText(state: SiteEditorState, id: string): string {
  const v = state.site[id];
  return v && (v.kind === "text" || v.kind === "longtext") ? v.value : "";
}
function pageText(state: SiteEditorState, slotId: string): string {
  const v = state.pages.home?.slots[slotId];
  return v && (v.kind === "text" || v.kind === "longtext") ? v.value : "";
}
function pageImage(state: SiteEditorState, slotId: string): ImageValue | null {
  const v = state.pages.home?.slots[slotId];
  return v && v.kind === "image" ? v.image : null;
}

function featureBlock(title: string, body: string): string {
  if (title.length === 0 && body.length === 0) return "";
  return `<div class="feature">
  ${title.length > 0 ? `<h3>${escapeHtml(title)}</h3>` : ""}
  ${paragraphsToHtml(body)}
</div>`;
}

function render(state: SiteEditorState, opts?: SerializeOpts): string {
  const siteName = escapeHtml(siteText(state, "siteName").trim()) || "untitled";
  const headline = escapeHtml(pageText(state, "heroHeadline").trim());
  const sub = paragraphsToHtml(pageText(state, "heroSub"));
  const heroImage = pageImage(state, "heroImage");
  const ctaLabel = escapeHtml(pageText(state, "ctaLabel").trim());
  const ctaUrlNormalised = normaliseUrl(pageText(state, "ctaUrl"));
  const ctaUrl = isSafeUrl(ctaUrlNormalised) ? ctaUrlNormalised : "";
  const features = [
    featureBlock(pageText(state, "feature1Title").trim(), pageText(state, "feature1Body")),
    featureBlock(pageText(state, "feature2Title").trim(), pageText(state, "feature2Body")),
    featureBlock(pageText(state, "feature3Title").trim(), pageText(state, "feature3Body")),
  ].filter((f) => f.length > 0);
  const aboutBody = paragraphsToHtml(pageText(state, "aboutBody"));

  const ctaBlock = ctaLabel.length > 0 && ctaUrl.length > 0
    ? `<a class="cta" href="${escapeHtml(ctaUrl)}" target="_blank" rel="noopener noreferrer">${ctaLabel}</a>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${siteName}${headline.length > 0 ? ` — ${headline}` : ""}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root { ${paletteVars(opts?.palette)} }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--ink); color: var(--bone); }
  body {
    font-family: 'Inter', system-ui, -apple-system, sans-serif;
    font-size: 17px;
    line-height: 1.65;
    -webkit-font-smoothing: antialiased;
    -webkit-text-size-adjust: 100%;
  }
  header.topbar {
    padding: 28px 36px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  header.topbar .brand {
    font-family: 'Space Grotesk', system-ui, sans-serif;
    font-weight: 700;
    font-size: 17px;
    letter-spacing: -0.01em;
    color: var(--bone);
  }
  main section[data-page] { display: block; }
  main section[data-page][hidden] { display: none; }
  section.hero {
    padding: 56px 36px 80px;
    max-width: 1100px;
    margin: 0 auto;
    text-align: center;
  }
  h1.headline {
    font-family: 'Space Grotesk', system-ui, sans-serif;
    font-weight: 700;
    font-size: clamp(44px, 7vw, 88px);
    line-height: 1.02;
    letter-spacing: -0.03em;
    margin: 0 0 24px;
    color: var(--bone);
    text-wrap: balance;
  }
  .sub {
    font-size: clamp(18px, 2vw, 22px);
    line-height: 1.5;
    color: var(--ash);
    max-width: 56ch;
    margin: 0 auto 36px;
  }
  .sub p { margin: 0 0 0.75em; }
  a.cta {
    display: inline-block;
    background: var(--copper);
    color: var(--ink);
    text-decoration: none;
    font-family: 'Space Grotesk', system-ui, sans-serif;
    font-weight: 600;
    font-size: 17px;
    padding: 16px 32px;
    border-radius: 8px;
    margin: 0 0 56px;
    transition: transform 140ms ease;
  }
  a.cta:hover { transform: translateY(-2px); }
  figure.hero {
    margin: 0;
    aspect-ratio: 16 / 9;
    overflow: hidden;
    border-radius: 4px;
    max-width: 1100px;
    margin: 0 auto;
  }
  figure.hero img { display: block; width: 100%; height: 100%; object-fit: cover; }
  section.features {
    padding: 96px 36px;
    max-width: 1100px;
    margin: 0 auto;
  }
  .features-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 36px;
  }
  .feature h3 {
    font-family: 'Space Grotesk', system-ui, sans-serif;
    font-weight: 600;
    font-size: 22px;
    line-height: 1.2;
    color: var(--bone);
    margin: 0 0 12px;
  }
  .feature p {
    color: var(--ash);
    font-size: 16px;
    line-height: 1.65;
    margin: 0 0 0.75em;
  }
  section.about {
    padding: 56px 36px 96px;
    max-width: 64ch;
    margin: 0 auto;
  }
  section.about p {
    margin: 0 0 1em;
    color: var(--bone);
    font-size: 17px;
    line-height: 1.7;
  }
  footer.foot {
    padding: 32px 36px;
    border-top: 1px solid var(--rule);
    text-align: center;
    color: var(--ash);
    font-size: 14px;
    font-family: 'Space Grotesk', system-ui, sans-serif;
    letter-spacing: 0.02em;
  }
  ::selection { background: color-mix(in srgb, var(--copper) 35%, transparent); color: var(--bone); }
  @media (max-width: 600px) {
    header.topbar { padding: 20px; }
    section.hero { padding: 32px 20px 56px; }
    section.features { padding: 56px 20px; }
    section.about { padding: 32px 20px 56px; }
  }
</style>
</head>
<body>
<header class="topbar">
  <span class="brand">${siteName}</span>
</header>
<main>
  <section data-page="home">
    <section class="hero">
      <h1 class="headline">${headline}</h1>
      ${sub.length > 0 ? `<div class="sub">${sub}</div>` : ""}
      ${ctaBlock}
      ${heroImage ? `<figure class="hero">${inlineImageTag(heroImage, headline || siteName)}</figure>` : ""}
    </section>
    ${features.length > 0 ? `<section class="features"><div class="features-grid">${features.join("")}</div></section>` : ""}
    ${aboutBody.length > 0 ? `<section class="about">${aboutBody}</section>` : ""}
  </section>
</main>
<footer class="foot">${siteName}</footer>
${routerScript()}
</body>
</html>
`;
}

export const landingTemplate: SiteTemplate = {
  id: "landing",
  name: "Landing Page",
  description: "Single-page rich landing — huge headline, optional hero image, three feature blocks, about. Bold sans-serif.",
  siteSlots: SITE_SLOTS,
  pages: PAGES,
  serialize: render,
};
