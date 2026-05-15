// Display helpers for the History tab. Pure functions — kept separate
// from the IPC layer so they can be unit-tested without a Tauri host.

/** Short, human-friendly age relative to `now`. Falls back to an ISO
 *  date for anything older than a week — the goal is "you can tell
 *  at a glance how recent this is", not precision. */
export function relativeTime(tsMs: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - tsMs);
  const s = Math.floor(diff / 1000);
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(tsMs).toISOString().slice(0, 10);
}

/** First-6 + last-4 of a 64-hex address, separated by `…`. Anything
 *  shorter than 14 chars is returned unchanged. */
export function shortAddress(addr: string): string {
  if (addr.length < 14) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/** Human label for each kind. */
export function kindLabel(kind: string): string {
  switch (kind) {
    case "text":
      return "Text";
    case "file":
      return "File";
    case "blog":
      return "Blog";
    case "site":
      return "Site";
    default:
      return kind;
  }
}
