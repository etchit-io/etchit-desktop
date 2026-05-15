// Frozen spec constants from docs/chainmark-format-v1.md §4.1 / §3.
//
// These bytes are protocol contract: any edit (whitespace,
// punctuation, case, anything) changes the signature, changes the
// derived key, and silently makes every existing user's sync break.
// Bump the spec version + add a migration before touching them.

/** EIP-191 personal_sign message that derives the chainmark key.
 *  §4.1 — exactly 137 UTF-8 bytes; SHA-256
 *  = `ab6f4ae288e6053c3e2181c83e33065c870a8b58b76b1d6b0072aba658cecab0`. */
export const SIGN_MESSAGE =
  "etchit chainmark v1\n\n" +
  "Sign this message to derive your chainmark key. " +
  "This signature does NOT authorize any transaction or transfer.";

/** Defence-in-depth: hash the SIGN_MESSAGE at load time and abort
 *  loudly if it has drifted. A silent edit upstream would silently
 *  change the derived key for every wallet — this turns that into a
 *  hard failure instead. Run from the module entry. */
export const SIGN_MESSAGE_SHA256 =
  "ab6f4ae288e6053c3e2181c83e33065c870a8b58b76b1d6b0072aba658cecab0";

/** §3 chain target — Arbitrum One. v1 clients MUST refuse to read
 *  or write libraries on any other chain. */
export const CHAINMARK_CHAIN_ID = 42161;
