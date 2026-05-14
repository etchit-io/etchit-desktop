import type { Template } from "./types";
import { TEMPLATES } from "./templates";

// Tiny per-template mini-previews — schematic blocks that suggest the
// shape of the rendered page so a first-time user can pick the layout
// closest to what they have in mind without reading every description.
const PREVIEWS: Record<string, string> = {
  classic: `
    <div class="pp-title"></div>
    <div class="pp-lede"></div>
    <div class="pp-rule"></div>
    <div class="pp-line"></div>
    <div class="pp-line"></div>
    <div class="pp-line short"></div>
    <div class="pp-line"></div>
    <div class="pp-line short"></div>
  `,
  article: `
    <div class="pp-title tall"></div>
    <div class="pp-lede"></div>
    <div class="pp-byline"></div>
    <div class="pp-image small"></div>
    <div class="pp-line"></div>
    <div class="pp-pull"></div>
    <div class="pp-line"></div>
  `,
  featured: `
    <div class="pp-title"></div>
    <div class="pp-lede"></div>
    <div class="pp-row">
      <div class="pp-square"></div>
      <div class="pp-text-col">
        <div class="pp-line"></div>
        <div class="pp-line short"></div>
        <div class="pp-line"></div>
        <div class="pp-line short"></div>
      </div>
    </div>
    <div class="pp-line"></div>
  `,
  illustrated: `
    <div class="pp-title"></div>
    <div class="pp-image"></div>
    <div class="pp-line"></div>
    <div class="pp-line short"></div>
    <div class="pp-image small"></div>
    <div class="pp-line"></div>
  `,
  photoEssay: `
    <div class="pp-title"></div>
    <div class="pp-pair"><div class="pp-img-mini"></div><div class="pp-cap-mini"></div></div>
    <div class="pp-pair"><div class="pp-img-mini"></div><div class="pp-cap-mini"></div></div>
    <div class="pp-pair"><div class="pp-img-mini"></div><div class="pp-cap-mini"></div></div>
  `,
  tutorial: `
    <div class="pp-title"></div>
    <div class="pp-line short"></div>
    <div class="pp-step"><span class="pp-num">01</span><div class="pp-cap-mini"></div></div>
    <div class="pp-step"><span class="pp-num">02</span><div class="pp-cap-mini"></div></div>
    <div class="pp-step"><span class="pp-num">03</span><div class="pp-cap-mini"></div></div>
  `,
  note: `
    <div class="pp-spacer"></div>
    <div class="pp-byline narrow"></div>
    <div class="pp-line"></div>
    <div class="pp-line short"></div>
    <div class="pp-line"></div>
    <div class="pp-spacer"></div>
  `,
};

export function mountTemplatePicker(host: HTMLElement, onPick: (template: Template) => void): void {
  host.innerHTML = `
    <header class="blog-pick-header">
      <h1>Blogger</h1>
      <p class="blog-pick-lede">
        Pick a layout. You can switch later, but switching clears slot contents
        for that template.
      </p>
    </header>
    <div class="blog-pick-grid"></div>
  `;

  const grid = host.querySelector(".blog-pick-grid") as HTMLElement;
  for (const tmpl of TEMPLATES) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "blog-pick-card";
    card.dataset.template = tmpl.id;
    card.innerHTML = `
      <div class="blog-pick-preview blog-pick-preview-${tmpl.id}">${PREVIEWS[tmpl.id] ?? ""}</div>
      <h2 class="blog-pick-name">${tmpl.name}</h2>
      <p class="blog-pick-desc">${tmpl.description}</p>
    `;
    card.addEventListener("click", () => onPick(tmpl));
    grid.appendChild(card);
  }
}
