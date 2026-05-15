// AES-256-GCM wrap/unwrap around a single data-map.
//
// Wire format inside `private_etches.json :: cipher_data_map`:
//   12 bytes IV  ||  ciphertext  ||  16 byte GCM tag
//
// All hex-encoded (lowercase, no `0x`) so the JSON stays text. The
// IV is fresh per entry — never reused, AES-GCM is brittle to nonce
// reuse under the same key.

const IV_LEN = 12;

/** Encrypt a data-map hex string. Returns hex of `iv || ct`. */
export async function encryptDataMap(
  key: Uint8Array,
  dataMapHex: string,
): Promise<string> {
  const aesKey = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const plaintext = new TextEncoder().encode(dataMapHex);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource, tagLength: 128 },
      aesKey,
      plaintext as BufferSource,
    ),
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return bytesToHex(out);
}

/** Decrypt a `iv || ct` hex string back to the data-map hex string.
 *  Returns `null` on any AEAD / parse failure — caller treats null
 *  as "skip / wrong key". */
export async function decryptDataMap(
  key: Uint8Array,
  cipherHex: string,
): Promise<string | null> {
  let bytes: Uint8Array;
  try {
    bytes = hexToBytes(cipherHex);
  } catch {
    return null;
  }
  if (bytes.length < IV_LEN + 16) return null;
  const iv = bytes.subarray(0, IV_LEN);
  const ct = bytes.subarray(IV_LEN);
  let plaintext: Uint8Array;
  try {
    const aesKey = await crypto.subtle.importKey(
      "raw",
      key as BufferSource,
      { name: "AES-GCM" },
      false,
      ["decrypt"],
    );
    plaintext = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: iv as BufferSource, tagLength: 128 },
        aesKey,
        ct as BufferSource,
      ),
    );
  } catch {
    return null;
  }
  return new TextDecoder().decode(plaintext);
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function hexToBytes(s: string): Uint8Array {
  if (s.length % 2 !== 0) throw new Error("odd hex length");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
