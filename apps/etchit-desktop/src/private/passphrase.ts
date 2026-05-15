// 6-word BIP-39 diceware generator + strength meter for the
// password-based backup flow. Byte-identical to the old desktop's
// `crypto/backup.ts :: generatePassphrase`.

import { BIP39_WORDLIST } from "./wordlist-bip39";
import { MIN_BACKUP_PASSWORD_LEN } from "./spec";

/** Diceware-style passphrase from the BIP-39 wordlist. 6 words yields
 *  log2(2048^6) ≈ 66 bits of entropy — well above the EFF
 *  "valuable accounts" recommendation.
 *
 *  Rejection-sampling avoids modulo bias on the wordlist length. 2048
 *  is a clean power of 2 so the bias would be zero, but the function
 *  stays honest if the list ever changes. */
export function generatePassphrase(numWords: number = 6): string {
  const words: string[] = [];
  const max = BIP39_WORDLIST.length;
  while (words.length < numWords) {
    const buf = crypto.getRandomValues(new Uint16Array(numWords - words.length));
    for (let i = 0; i < buf.length && words.length < numWords; i++) {
      const v = buf[i];
      if (v < 65536 - (65536 % max)) words.push(BIP39_WORDLIST[v % max]);
    }
  }
  return words.join("-");
}

export type StrengthClass = "ok" | "err" | "warn" | "";

/** Tiny meter for the custom-password fallback. Diceware path
 *  bypasses this — six BIP-39 words is "Strong" by definition. */
export function passwordStrength(pw: string): { label: string; cls: StrengthClass } {
  if (!pw) return { label: "", cls: "" };
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((re) => re.test(pw)).length;
  if (pw.length < MIN_BACKUP_PASSWORD_LEN) {
    return { label: `Weak — use at least ${MIN_BACKUP_PASSWORD_LEN} characters`, cls: "err" };
  }
  if (pw.length >= 12 || classes >= 3) return { label: "Strong", cls: "ok" };
  return { label: "OK — stronger with mixed character types", cls: "warn" };
}
