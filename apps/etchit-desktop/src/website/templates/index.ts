import type { SiteTemplate } from "../types";

import { landingTemplate } from "./landing";
import { personalTemplate } from "./personal";
import { portfolioTemplate } from "./portfolio";

export const SITE_TEMPLATES: readonly SiteTemplate[] = [
  personalTemplate,
  portfolioTemplate,
  landingTemplate,
];

export function siteTemplateById(id: string): SiteTemplate | undefined {
  return SITE_TEMPLATES.find((t) => t.id === id);
}
