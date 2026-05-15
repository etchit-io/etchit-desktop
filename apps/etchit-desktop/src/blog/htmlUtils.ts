// Shared HTML helpers for blog-template serializers. Order of escape
// matters — `&` must run first or it will double-encode the others.

import type { BlogPalette, ImageValue } from "./types";

const SAFE_SCHEMES = /^(https?:|mailto:|autonomi:|tel:)/i;
const DANGEROUS_SCHEMES = /^(javascript:|data:|vbscript:|file:|blob:)/i;
const HEX64 = /^[0-9a-f]{64}$/i;
const EMAILISH = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Normalise user-typed URLs/handles to a safe `href` value.
 *
 *  Auto-promotes to schemes that actually work inside fetch>it (which
 *  is Autonomi-only at runtime): 64-hex becomes `autonomi://`, an
 *  email-shaped string becomes `mailto:`. Explicit safe schemes
 *  (`autonomi:`, `mailto:`, `tel:`, `http(s):`) pass through; the
 *  clearnet ones work only when the page is read through a clearnet
 *  gateway, not from inside fetch>it itself, but we honour user intent
 *  if they typed the scheme deliberately.
 *
 *  Dangerous schemes (`javascript:`, `data:`, `vbscript:`, `file:`,
 *  `blob:`) return empty — templates then fall back to `#` via
 *  [`isSafeUrl`]. Bare strings with no scheme also return empty: we
 *  used to silently prepend `https://`, but fetch>it can't load
 *  clearnet pages, so a guessed link would just be a broken link. The
 *  caller treats empty as "render as text, not as an anchor." */
export function normaliseUrl(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) return "";
  if (DANGEROUS_SCHEMES.test(trimmed)) return "";
  if (SAFE_SCHEMES.test(trimmed)) return trimmed;
  if (HEX64.test(trimmed)) return `autonomi://${trimmed.toLowerCase()}`;
  if (EMAILISH.test(trimmed)) return `mailto:${trimmed}`;
  return "";
}

/** Whether a URL string is one of the schemes a published page is
 *  allowed to link to. Acts as a final safety net after
 *  [`normaliseUrl`] in case the normaliser ever lets something
 *  unexpected through. */
export function isSafeUrl(url: string): boolean {
  return SAFE_SCHEMES.test(url);
}

/** Whether the user-typed string starts with a dangerous URL scheme.
 *  Templates filter dangerous entries out of link lists entirely so
 *  the raw `javascript:`/`data:`/etc. content doesn't even appear as
 *  visible text in the rendered page. */
export function isDangerousUrl(url: string): boolean {
  return DANGEROUS_SCHEMES.test(url.trim());
}

/** Emit the CSS custom properties that drive a template's `:root` color
 *  scheme. Two palettes ship today — dark (etch/it brand default) and
 *  light. Each template inserts `paletteVars(palette)` inside its own
 *  `:root { ... }` block, so the same template renders either way. */
export function paletteVars(palette: BlogPalette = "dark"): string {
  if (palette === "light") {
    return `--ink: #f5f2eb; --ink-2: #ece5d3; --copper: #b87333; --bone: #1a1814; --ash: #5c5650; --rule: #d8d2c4;`;
  }
  return `--ink: #0a0a0a; --ink-2: #141414; --copper: #c9732b; --bone: #f5f2eb; --ash: #8a8a8a; --rule: #2a2a2a;`;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Split body text on blank lines, collapse internal whitespace, trim. */
export function paragraphize(text: string): string[] {
  const normalised = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const blocks = normalised.split(/\n[\t ]*\n+/);
  return blocks
    .map((b) => b.trim().replace(/\s+/g, " "))
    .filter((b) => b.length > 0);
}

export function paragraphsToHtml(text: string, emptyPlaceholder?: string): string {
  const paras = paragraphize(text);
  if (paras.length === 0) {
    return emptyPlaceholder ?? "";
  }
  return paras.map((p) => `<p>${escapeHtml(p)}</p>`).join("\n");
}

/** `<img>` tag with `alt`, lazy loading, and a data: src. Carries the
 *  user's crop choices as inline `object-position` and `transform` so
 *  aspect-cropped images publish at the exact framing the composer
 *  showed. Default-centred + scale 1 images get clean tags with no style. */
export function inlineImageTag(image: ImageValue, alt: string): string {
  const pos = image.objectPosition;
  const scale = image.scale ?? 1;
  const hasPan = pos && (pos.x !== 50 || pos.y !== 50);
  const hasZoom = scale !== 1;
  const parts: string[] = [];
  if (hasPan && pos) {
    parts.push(`object-position: ${pos.x.toFixed(1)}% ${pos.y.toFixed(1)}%`);
  }
  if (hasZoom) {
    const origin = hasPan && pos ? `${pos.x.toFixed(1)}% ${pos.y.toFixed(1)}%` : "50.0% 50.0%";
    parts.push(`transform: scale(${scale.toFixed(3)})`);
    parts.push(`transform-origin: ${origin}`);
  }
  const styleAttr = parts.length > 0 ? ` style="${parts.join("; ")}"` : "";
  return `<img src="${image.dataUrl}" alt="${escapeHtml(alt)}" loading="lazy"${styleAttr}>`;
}
