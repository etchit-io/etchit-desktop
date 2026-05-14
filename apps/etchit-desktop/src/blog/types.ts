// Slot schema for the blog composer. Each template defines a list of
// Slots; the composer renders an editable field per slot; the template's
// serialize() turns the filled state into a final HTML page.

export type SlotKind = "text" | "longtext" | "image";

export interface AspectRatio {
  width: number;
  height: number;
}

/** Page palette. Determines the rendered HTML's color scheme — author
 *  picks dark or light per session (defaults to whichever app theme
 *  they chose). The composer canvas mirrors the same palette so the
 *  editor stays WYSIWYG. */
export type BlogPalette = "dark" | "light";

export interface SerializeOpts {
  palette?: BlogPalette;
}

export interface Slot {
  /** Stable identifier — used as the dataset key on the editable element. */
  id: string;
  kind: SlotKind;
  /** Visible placeholder copy ("Headline", "Drop hero image here", …). */
  placeholder: string;
  /**
   * Optional slots can be left empty without the composer counting them
   * as missing input. Required slots disable the Etch button until filled.
   */
  optional?: boolean;
  /**
   * For image slots: target aspect ratio. The composer renders the drop
   * zone at this ratio and center-crops the image with `object-fit: cover`;
   * the template's rendered HTML uses the same wrapping so what you see
   * is what publishes. Omit for "free" (image keeps its natural ratio).
   */
  aspect?: AspectRatio;
}

export interface ImageValue {
  /** `data:<mime>;base64,…` — ready to drop straight into `<img src>`.
   *  Always WebP after the composer's processor runs (canvas re-encode
   *  also strips EXIF / GPS / camera metadata in the process). */
  dataUrl: string;
  mimeType: string;
  /** Processed (post-resize) byte count. */
  sizeBytes: number;
  width: number;
  height: number;
  /** Original file size before re-encoding — for the "shrunk from X" hint. */
  originalSizeBytes: number;
  /** Crop offset for aspect-constrained slots. Stored as CSS
   *  `object-position` percentages (0..100). Defaults to 50/50 (centred).
   *  Only meaningful when the slot declares an `aspect`. */
  objectPosition?: { x: number; y: number };
  /** Zoom multiplier above the default `object-fit: cover` scale.
   *  1 = normal cover; >1 = zoomed in (less of image visible);
   *  clamped to [1, 4] by the composer. Only meaningful when the
   *  slot declares an `aspect`. */
  scale?: number;
}

export type SlotValue =
  | { kind: "text"; value: string }
  | { kind: "longtext"; value: string }
  | { kind: "image"; image: ImageValue };

export interface EditorState {
  templateId: string;
  /** Map of slot id → value, or `null` for empty (only valid for optional). */
  slots: Record<string, SlotValue | null>;
}

export interface Template {
  id: string;
  /** Human-readable name shown in the picker card. */
  name: string;
  /** One-line description shown in the picker card. */
  description: string;
  slots: readonly Slot[];
  /** Produces the final, self-contained `<!DOCTYPE html>` page.
   *  `opts.palette` controls the `:root` color scheme — defaults to dark. */
  serialize(state: EditorState, opts?: SerializeOpts): string;
  /**
   * Optional layout hook for the editor. When provided, the composer
   * hands the template a map of pre-built slot elements (already wired
   * with input handlers, drag/drop, image processing) and a container,
   * and the template arranges them however it likes — side-by-side
   * columns, grids, asymmetric splits, etc. so the editor looks
   * identical in layout to the published page.
   *
   * If omitted, the composer falls back to stacking slots vertically
   * in the order they're declared.
   */
  layoutEditor?(slots: Record<string, HTMLElement>, container: HTMLElement): void;
}
