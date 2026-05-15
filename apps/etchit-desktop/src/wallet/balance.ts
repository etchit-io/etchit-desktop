// Pure formatting helpers for wallet balances. No network, no AppKit
// — kept separate so the Wallet tab can test display logic without
// spinning up a real chain client.

/** Convert atto-ANT (or wei) decimal string to a human-readable token
 *  string with up to `places` decimal digits. Strips trailing zeros
 *  and the trailing dot when the fractional part is all zero. */
export function formatToken(atto: string, decimals: number = 18, places: number = 4): string {
  if (!/^\d+$/.test(atto)) return "—";
  const padded = atto.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals).replace(/^0+(?=\d)/, "");
  const frac = padded.slice(padded.length - decimals, padded.length - decimals + places);
  const trimmed = frac.replace(/0+$/, "");
  return trimmed.length === 0 ? whole : `${whole}.${trimmed}`;
}

/** First-6 + last-4 of a 0x-prefixed address. Anything shorter than
 *  10 chars is returned as-is. */
export function shortHexAddress(addr: string): string {
  if (addr.length < 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
