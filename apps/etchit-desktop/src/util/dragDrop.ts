// Wire a DOM element up as a file drop zone. Uses Tauri's window-level
// drag-drop event (the only path that yields real filesystem paths,
// rather than opaque File objects).
//
// Visibility-gated: when the bound element isn't currently rendered
// (`offsetParent === null` — tab not active or panel hidden), the
// handler is a no-op. That lets multiple drop zones coexist across
// tabs and reuse the same global event without conflicts.

import { getCurrentWebview } from "@tauri-apps/api/webview";

/** Bind a file drop zone. Calls `onFiles(paths)` when files are
 *  dropped on the visible drop zone. Adds `.is-dragging` to the
 *  element while the user is dragging over the webview.
 *
 *  Returns a cleanup function — call on remount to remove the
 *  listener. Calling cleanup is optional in practice because the
 *  tabs lazy-mount once and stay alive for the session. */
export function bindFileDropZone(
  el: HTMLElement,
  onFiles: (paths: string[]) => void,
): () => void {
  let unlisten: (() => void) | null = null;

  void getCurrentWebview()
    .onDragDropEvent((event) => {
      if (!isVisible(el)) return;
      const p = event.payload;
      if (p.type === "over") {
        el.classList.add("is-dragging");
      } else if (p.type === "drop") {
        el.classList.remove("is-dragging");
        const paths = (p as { paths?: string[] }).paths ?? [];
        if (paths.length > 0) onFiles(paths);
      } else {
        el.classList.remove("is-dragging");
      }
    })
    .then((u) => {
      unlisten = u;
    });

  return () => {
    unlisten?.();
  };
}

function isVisible(el: HTMLElement): boolean {
  // offsetParent is null whenever the element OR any ancestor has
  // `display: none` — exactly what we need: a hidden tab pane or a
  // mode-toggled section returns null.
  return el.offsetParent !== null;
}

/** Per-slot file drop targets sharing a single Tauri listener.
 *
 *  Tauri intercepts OS-level file drops *before* the WebView's HTML5
 *  dragover/drop events ever fire, so the blogger / website composer's
 *  per-slot HTML5 wiring silently does nothing in production. This
 *  helper subscribes once globally and hit-tests every drop against
 *  the currently-bound slot rects (skipping hidden ones via
 *  offsetParent), invoking the matching slot's callback with the
 *  filesystem paths Tauri hands us.
 *
 *  Tauri 2's `DragDropEvent.position` is in **logical** (CSS) pixels
 *  relative to the WebView, which matches `getBoundingClientRect`'s
 *  coord space — no devicePixelRatio dance needed.
 */
type SlotEntry = { el: HTMLElement; onPaths: (paths: string[]) => void };
const slots: SlotEntry[] = [];
let slotListenerInstalled = false;

function installSlotListener(): void {
  if (slotListenerInstalled) return;
  slotListenerInstalled = true;
  void getCurrentWebview().onDragDropEvent((event) => {
    const p = event.payload as
      | { type: "over"; position: { x: number; y: number } }
      | { type: "drop"; position: { x: number; y: number }; paths: string[] }
      | { type: "leave" | "cancel" };
    if (p.type === "over") {
      const { x, y } = p.position;
      for (const s of slots) {
        if (!isVisible(s.el)) {
          s.el.classList.remove("is-over");
          continue;
        }
        const r = s.el.getBoundingClientRect();
        const over = x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
        s.el.classList.toggle("is-over", over);
      }
    } else if (p.type === "drop") {
      const { x, y } = p.position;
      for (const s of slots) {
        s.el.classList.remove("is-over");
        if (!isVisible(s.el)) continue;
        const r = s.el.getBoundingClientRect();
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
          if (p.paths.length > 0) s.onPaths(p.paths);
          break; // first hit wins
        }
      }
    } else {
      for (const s of slots) s.el.classList.remove("is-over");
    }
  });
}

/** Register an element as a file drop target that gets filesystem
 *  paths on drop. Returns a cleanup function for remount. */
export function bindFileDropSlot(
  el: HTMLElement,
  onPaths: (paths: string[]) => void,
): () => void {
  installSlotListener();
  const entry: SlotEntry = { el, onPaths };
  slots.push(entry);
  return () => {
    const i = slots.indexOf(entry);
    if (i >= 0) slots.splice(i, 1);
  };
}
