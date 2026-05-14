// Extract a 64-hex Autonomi address from arbitrary `ant` CLI output. `ant`
// prints to stdout in human-readable form (header lines + progress dots + a
// final "uploaded to: <hex>" line), and to stderr for errors / progress.
// We tolerate either by scanning every token for an isolated 64-character
// hex run.

const HEX64 = /^[0-9a-f]{64}$/;

export function parseAddressFromOutput(output: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    for (const raw of line.split(/[^0-9a-zA-Z]+/)) {
      const lower = raw.toLowerCase();
      if (HEX64.test(lower)) return lower;
    }
  }
  return null;
}
