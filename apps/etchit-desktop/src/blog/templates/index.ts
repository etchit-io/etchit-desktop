import type { Template } from "../types";

import { articleTemplate } from "./article";
import { classicTemplate } from "./classic";
import { featuredTemplate } from "./featured";
import { illustratedTemplate } from "./illustrated";
import { noteTemplate } from "./note";
import { photoEssayTemplate } from "./photoEssay";
import { tutorialTemplate } from "./tutorial";

export const TEMPLATES: readonly Template[] = [
  classicTemplate,
  articleTemplate,
  featuredTemplate,
  illustratedTemplate,
  photoEssayTemplate,
  tutorialTemplate,
  noteTemplate,
];

export function templateById(id: string): Template | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
