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
