// Mirror of `secrets::normalize_key` in the Rust backend. The backend is the
// source of truth — this client-side copy exists only to keep the Store button
// disabled until the input looks plausible, so the user gets instant feedback
// instead of round-tripping a typo through the keychain command.

const HEX64 = /^[0-9a-f]{64}$/;

export function normalizeSecretKey(input: string): string | null {
  const trimmed = input.trim();
  const body = trimmed.startsWith("0x") || trimmed.startsWith("0X")
    ? trimmed.slice(2)
    : trimmed;
  const lower = body.toLowerCase();
  return HEX64.test(lower) ? lower : null;
}
