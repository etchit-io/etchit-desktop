import type { SiteTemplate } from "./types";
import { SITE_TEMPLATES } from "./templates";

// Each card shows a tiny CSS-only schematic of the site's published
// shape — sidebar+content for Personal, top-nav+grid for Portfolio,
// hero+features for Landing — so a first-time visitor picks the right
// layout without reading every description.
const PREVIEWS: Record<string, string> = {
  personal: `
    <div class="sp-personal">
      <div class="sp-side">
        <div class="sp-brand"></div>
        <div class="sp-link"></div>
        <div class="sp-link"></div>
        <div class="sp-link"></div>
        <div class="sp-link"></div>
      </div>
      <div class="sp-main">
        <div class="sp-avatar"></div>
        <div class="sp-headline"></div>
        <div class="sp-sub"></div>
      </div>
    </div>
  `,
  portfolio: `
    <div class="sp-portfolio">
      <div class="sp-topbar">
        <div class="sp-brand"></div>
        <div class="sp-nav"><span></span><span></span><span></span></div>
      </div>
      <div class="sp-grid">
        <div class="sp-tile"></div>
        <div class="sp-tile"></div>
        <div class="sp-tile"></div>
        <div class="sp-tile"></div>
      </div>
    </div>
  `,
  landing: `
    <div class="sp-landing">
      <div class="sp-headline-big"></div>
      <div class="sp-sub-big"></div>
      <div class="sp-cta"></div>
      <div class="sp-features">
        <div class="sp-feature"></div>
        <div class="sp-feature"></div>
        <div class="sp-feature"></div>
      </div>
    </div>
  `,
};

export function mountSiteTemplatePicker(host: HTMLElement, onPick: (template: SiteTemplate) => void): void {
  host.innerHTML = `
    <header class="blog-pick-header">
      <h1>Website</h1>
      <p class="blog-pick-lede">
        Pick a site shape. Each one is multi-page in a single upload &mdash; one address,
        full navigation, everything inlined.
      </p>
    </header>
    <div class="site-pick-grid"></div>
  `;
  const grid = host.querySelector(".site-pick-grid") as HTMLElement;
  for (const tmpl of SITE_TEMPLATES) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "site-pick-card";
    card.dataset.template = tmpl.id;
    card.innerHTML = `
      <div class="site-pick-preview site-pick-preview-${tmpl.id}">${PREVIEWS[tmpl.id] ?? ""}</div>
      <h2 class="site-pick-name">${tmpl.name}</h2>
      <p class="site-pick-desc">${tmpl.description}</p>
    `;
    card.addEventListener("click", () => onPick(tmpl));
    grid.appendChild(card);
  }
}
