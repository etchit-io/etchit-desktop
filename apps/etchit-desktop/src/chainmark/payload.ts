// Chainmark v1 payload JSON codec. §9 of the spec.
//
// Encoding is strict: caller-provided fields must be in the allowed
// sets or `encode` throws (programmer error).
//
// Decoding is tolerant: unknown top-level fields are ignored, entries
// with unknown `kind` / `action`, invalid `addr`, oversize `title`,
// or missing required fields are silently skipped per §9 / §11.

export const SCHEMA_VERSION = 1;

export type WireKind = "public";
export type WireAction = "add" | "bookmark" | "hide";

const ALLOWED_KINDS = ["public"] as const;
const ALLOWED_ACTIONS = ["add", "bookmark", "hide"] as const;

const MAX_TITLE_BYTES = 256;

export interface WireEntry {
  kind: WireKind;
  addr: string;
  title: string;
  ts: number;
  action: WireAction;
}

/** Serialize a list of entries into the chainmark payload JSON
 *  (UTF-8 bytes via the caller). Throws on caller-side programmer
 *  errors — unknown kind/action — so we don't silently encode
 *  something the readers will skip. */
export function encode(entries: WireEntry[]): string {
  for (const e of entries) {
    if (!ALLOWED_KINDS.includes(e.kind as WireKind)) {
      throw new Error(`unknown kind: ${e.kind}`);
    }
    if (!ALLOWED_ACTIONS.includes(e.action as WireAction)) {
      throw new Error(`unknown action: ${e.action}`);
    }
  }
  return JSON.stringify({
    v: SCHEMA_VERSION,
    entries: entries.map((e) => ({
      kind: e.kind,
      addr: e.addr,
      title: e.title,
      ts: e.ts,
      action: e.action,
    })),
  });
}

/** Parse a chainmark payload JSON. Returns `null` if the envelope
 *  itself is malformed (different schema version, not an object,
 *  no entries array). Returns an array (possibly empty) of valid
 *  entries — individual malformed entries are skipped silently
 *  per spec §9 / §11.2. */
export function decode(json: string): WireEntry[] | null {
  let root: unknown;
  try {
    root = JSON.parse(json);
  } catch {
    return null;
  }
  if (root === null || typeof root !== "object") return null;
  const r = root as Record<string, unknown>;
  if (r.v !== SCHEMA_VERSION) return null;
  const arr = r.entries;
  if (!Array.isArray(arr)) return null;

  const out: WireEntry[] = [];
  for (const raw of arr) {
    if (raw === null || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    if (typeof o.kind !== "string" || !(ALLOWED_KINDS as readonly string[]).includes(o.kind)) {
      continue;
    }
    if (
      typeof o.action !== "string" ||
      !(ALLOWED_ACTIONS as readonly string[]).includes(o.action)
    ) {
      continue;
    }
    if (typeof o.addr !== "string" || !isValidAddr(o.addr)) continue;
    if (typeof o.title !== "string") continue;
    if (new TextEncoder().encode(o.title).length > MAX_TITLE_BYTES) continue;
    if (typeof o.ts !== "number" || !Number.isFinite(o.ts)) continue;
    out.push({
      kind: o.kind as WireKind,
      addr: o.addr,
      title: o.title,
      ts: o.ts,
      action: o.action as WireAction,
    });
  }
  return out;
}

function isValidAddr(s: string): boolean {
  if (s.length !== 64) return false;
  for (const c of s) {
    if (!((c >= "0" && c <= "9") || (c >= "a" && c <= "f"))) return false;
  }
  return true;
}
