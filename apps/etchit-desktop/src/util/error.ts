// Format any thrown value as a human-readable string.
//
// EIP-1193 wallet errors (and most JSON-RPC errors) throw shapes like
// `{ code, message, data }` that produce the useless string
// `[object Object]` under `String(e)` or `${e}`. AppKit, Tauri's
// `invoke` rejection, and our own Rust commands all surface different
// shapes; this normalises them.

interface MessageBag {
  message?: unknown;
  reason?: unknown;
  data?: { message?: unknown };
}

export function formatErr(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object") {
    const bag = e as MessageBag;
    if (typeof bag.message === "string") return bag.message;
    if (typeof bag.reason === "string") return bag.reason;
    if (bag.data && typeof bag.data.message === "string") return bag.data.message;
    // Last resort: a JSON dump beats the `[object Object]` sentinel.
    try {
      return JSON.stringify(e);
    } catch {
      // fall through
    }
  }
  return String(e);
}
