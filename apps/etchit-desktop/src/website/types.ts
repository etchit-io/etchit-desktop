// Multi-page site types. Reuses the Blogger slot model wholesale; a
// website is just "Blogger but the user fills several pages and the
// pages get glued together into one navigable HTML document."

import type { SerializeOpts, Slot, SlotValue } from "../blog/types";

export interface Page {
  /** Stable identifier — used as the hash fragment and the section's
   *  `data-page` attribute in the published HTML. */
  id: string;
  /** Display name — shown in the editor's page-tab strip and in the
   *  published site's navigation. */
  name: string;
  slots: readonly Slot[];
}

export interface SitePageState {
  slots: Record<string, SlotValue | null>;
}

export interface SiteEditorState {
  templateId: string;
  /** Top-level slots — at minimum a site name, possibly contact email
   *  or other fields shared across every page. */
  site: Record<string, SlotValue | null>;
  pages: Record<string, SitePageState>;
}

export interface SiteTemplate {
  id: string;
  /** Human-readable name shown in the picker card. */
  name: string;
  /** One-line description shown in the picker card. */
  description: string;
  /** Site-wide slots — shown above the page-tab strip in the editor. */
  siteSlots: readonly Slot[];
  pages: readonly Page[];
  /** Produces one self-contained `<!DOCTYPE html>` document containing
   *  every page, a hash-router, and the chosen palette. */
  serialize(state: SiteEditorState, opts?: SerializeOpts): string;
}
