// Multi-page site composer. Reuses Blogger's slot UI factories
// (renderSlot, wireSlot) so every page gets the same drop zones, image
// processor, drag-pan, wheel-zoom, dblclick-zoom — every primitive.
// Above the per-page editor sits a site-level slot strip (siteName,
// etc.) and a page-tab bar; selecting a tab swaps which page's slot
// container is visible. State is held per-page and merged into a
// SiteEditorState on demand.

import { countWords, hasValue, renderSlot, sumImageBytes, wireSlot } from "../blog/composer";
import type { SlotValue } from "../blog/types";
import type { SiteEditorState, SiteTemplate } from "./types";

/** Description of an unfilled required slot — used by the editor to
 *  point the author at exactly what's blocking Preview / Etch. */
export interface MissingSlot {
  /** `null` when the slot lives at the site level (above the page
   *  tabs), otherwise the page id it belongs to. */
  pageId: string | null;
  /** Display name of the page, or "Site" for site-level slots. */
  pageName: string;
  slotId: string;
  placeholder: string;
}

export interface SiteComposerHandle {
  getState(): SiteEditorState;
  isReady(): boolean;
  /** Empty when [`isReady`] is `true`. Lists every required slot still
   *  missing content, in stable page-then-declaration order. */
  missing(): MissingSlot[];
  /** Imperatively switch to the given page tab. Used by the editor to
   *  jump straight to the page holding the first missing slot. */
  goToPage(id: string): void;
  totalImageBytes(): number;
  wordCount(): number;
  onChange(handler: () => void): void;
}

export function mountSiteComposer(host: HTMLElement, template: SiteTemplate): SiteComposerHandle {
  host.innerHTML = `
    <div class="site-composer" data-template="${template.id}">
      <div class="site-slots"></div>
      <div class="site-page-tabs" role="tablist"></div>
      <div class="site-page-content"></div>
    </div>
  `;
  const canvas = host.querySelector(".site-composer") as HTMLElement;
  const siteSlotsHost = canvas.querySelector(".site-slots") as HTMLElement;
  const tabsHost = canvas.querySelector(".site-page-tabs") as HTMLElement;
  const contentHost = canvas.querySelector(".site-page-content") as HTMLElement;

  const siteState: Record<string, SlotValue | null> = {};
  for (const slot of template.siteSlots) siteState[slot.id] = null;

  const pageStates: Record<string, Record<string, SlotValue | null>> = {};
  for (const page of template.pages) {
    const ps: Record<string, SlotValue | null> = {};
    for (const slot of page.slots) ps[slot.id] = null;
    pageStates[page.id] = ps;
  }

  const listeners: Array<() => void> = [];
  const notify = (): void => {
    for (const h of listeners) h();
  };

  for (const slot of template.siteSlots) {
    const slotEl = renderSlot(slot);
    wireSlot(slotEl, slot, siteState, notify);
    siteSlotsHost.appendChild(slotEl);
  }

  const pageContainers: Record<string, HTMLElement> = {};
  const tabButtons: Record<string, HTMLButtonElement> = {};
  for (const page of template.pages) {
    const container = document.createElement("div");
    container.className = "site-page";
    container.dataset.page = page.id;
    for (const slot of page.slots) {
      const slotEl = renderSlot(slot);
      wireSlot(slotEl, slot, pageStates[page.id], notify);
      container.appendChild(slotEl);
    }
    container.hidden = true;
    contentHost.appendChild(container);
    pageContainers[page.id] = container;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "site-page-tab";
    btn.dataset.page = page.id;
    btn.textContent = page.name;
    btn.addEventListener("click", () => switchPage(page.id));
    tabsHost.appendChild(btn);
    tabButtons[page.id] = btn;
  }

  function switchPage(id: string): void {
    for (const [pid, el] of Object.entries(pageContainers)) el.hidden = pid !== id;
    for (const [pid, btn] of Object.entries(tabButtons)) btn.classList.toggle("is-active", pid === id);
  }
  if (template.pages[0]) switchPage(template.pages[0].id);
  // Hide the tab strip entirely for single-page sites (Landing).
  if (template.pages.length <= 1) tabsHost.hidden = true;

  const getState = (): SiteEditorState => ({
    templateId: template.id,
    site: { ...siteState },
    pages: Object.fromEntries(
      Object.entries(pageStates).map(([pid, slots]) => [pid, { slots: { ...slots } }]),
    ),
  });

  const missing = (): MissingSlot[] => {
    const out: MissingSlot[] = [];
    for (const slot of template.siteSlots) {
      if (!slot.optional && !hasValue(siteState[slot.id])) {
        out.push({ pageId: null, pageName: "Site", slotId: slot.id, placeholder: slot.placeholder });
      }
    }
    for (const page of template.pages) {
      const ps = pageStates[page.id];
      for (const slot of page.slots) {
        if (!slot.optional && !hasValue(ps[slot.id])) {
          out.push({ pageId: page.id, pageName: page.name, slotId: slot.id, placeholder: slot.placeholder });
        }
      }
    }
    return out;
  };
  const isReady = (): boolean => missing().length === 0;

  const totalImageBytes = (): number => {
    let total = sumImageBytes(siteState);
    for (const ps of Object.values(pageStates)) total += sumImageBytes(ps);
    return total;
  };

  const wordCountAll = (): number => {
    let total = countWords(siteState);
    for (const ps of Object.values(pageStates)) total += countWords(ps);
    return total;
  };

  return {
    getState,
    isReady,
    missing,
    goToPage: switchPage,
    totalImageBytes,
    wordCount: wordCountAll,
    onChange: (h) => {
      listeners.push(h);
    },
  };
}
