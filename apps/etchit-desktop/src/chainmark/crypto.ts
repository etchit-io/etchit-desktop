// Chainmark v1 crypto primitives. Byte-exact implementation of
// §4–§8 of `docs/chainmark-format-v1.md`. The Kotlin reference at
// `app/.../chainmark/ChainmarkCrypto.kt` is the cross-client truth;
// this module is its WebCrypto twin. Test vectors run against the
// same fixtures to guarantee round-trip parity.
//
// WebCrypto covers everything we need: HKDF-SHA256 for key
// derivation, AES-256-GCM for sealing, SHA-256 for the recipient
// address. No external deps.

export const VERSION_BYTE = 0x01;
export const NONCE_LEN = 12;
export const TAG_LEN = 16;
export const KEY_LEN = 32;
export const IKM_LEN = 64;

/** §6 padding buckets (bytes). Must stay aligned to the spec. */
export const BUCKETS = [1024, 4096, 16384] as const;

const FRAME_LEN_FIELD = 4;
const HKDF_INFO_BYTES = new TextEncoder().encode("etchit-chainmark/v1/aead-key");
const RECIPIENT_PREFIX_BYTES = new TextEncoder().encode("etchit-chainmark-v1/recipient");

/** Derive the 32-byte AEAD key from a 64-byte IKM (`r || s` of the
 *  EIP-191 `personal_sign` signature). HKDF-SHA256, empty salt, info
 *  per §4.3. */
export async function deriveKey(ikm: Uint8Array): Promise<Uint8Array> {
  if (ikm.length !== IKM_LEN) {
    throw new Error(`IKM must be ${IKM_LEN} bytes (r||s of personal_sign)`);
  }
  const importedIkm = await crypto.subtle.importKey(
    "raw",
    ikm as BufferSource,
    { name: "HKDF" },
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: HKDF_INFO_BYTES,
    },
    importedIkm,
    KEY_LEN * 8,
  );
  return new Uint8Array(bits);
}

/** Select the smallest bucket that fits `payloadLen` framed bytes
 *  (4-byte length prefix included). Returns the bucket index
 *  (0/1/2) or `null` if the payload exceeds the largest bucket. */
export function selectBucket(payloadLen: number): number | null {
  if (payloadLen < 0) return null;
  const needed = FRAME_LEN_FIELD + payloadLen;
  for (let i = 0; i < BUCKETS.length; i++) {
    if (needed <= BUCKETS[i]) return i;
  }
  return null;
}

/** Seal a payload into a v1 chainmark blob. Returns the on-wire
 *  calldata bytes (header + ciphertext + GCM tag) or `null` if the
 *  payload doesn't fit any bucket. A caller-supplied `nonce` is for
 *  tests; production callers MUST pass `null` to get a CSPRNG nonce. */
export async function seal(
  key: Uint8Array,
  payload: Uint8Array,
  nonce: Uint8Array | null = null,
): Promise<Uint8Array | null> {
  if (key.length !== KEY_LEN) throw new Error(`key must be ${KEY_LEN} bytes`);
  const bucketId = selectBucket(payload.length);
  if (bucketId === null) return null;
  const bucketSize = BUCKETS[bucketId];

  // §8 plaintext frame: little-endian u32 length, payload, zero-pad.
  const frame = new Uint8Array(bucketSize);
  new DataView(frame.buffer).setUint32(0, payload.length, true);
  frame.set(payload, FRAME_LEN_FIELD);

  const n = nonce ?? randomNonce();
  if (n.length !== NONCE_LEN) throw new Error(`nonce must be ${NONCE_LEN} bytes`);

  const aesKey = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: n as BufferSource, tagLength: 128 },
      aesKey,
      frame as BufferSource,
    ),
  );

  const blob = new Uint8Array(2 + NONCE_LEN + ct.length);
  blob[0] = VERSION_BYTE;
  blob[1] = bucketId;
  blob.set(n, 2);
  blob.set(ct, 2 + NONCE_LEN);
  return blob;
}

/** Unseal a chainmark blob. Returns the inner payload bytes, or
 *  `null` on any structural / AEAD failure (silent skip — §11.2). */
export async function open(
  key: Uint8Array,
  blob: Uint8Array,
): Promise<Uint8Array | null> {
  if (key.length !== KEY_LEN) return null;
  if (blob.length < 2 + NONCE_LEN + TAG_LEN) return null;
  if (blob[0] !== VERSION_BYTE) return null;
  const bucketId = blob[1];
  if (bucketId < 0 || bucketId >= BUCKETS.length) return null;
  const bucketSize = BUCKETS[bucketId];
  if (blob.length !== 2 + NONCE_LEN + bucketSize + TAG_LEN) return null;

  const nonce = blob.subarray(2, 2 + NONCE_LEN);
  const ct = blob.subarray(2 + NONCE_LEN);
  let frame: Uint8Array;
  try {
    const aesKey = await crypto.subtle.importKey(
      "raw",
      key as BufferSource,
      { name: "AES-GCM" },
      false,
      ["decrypt"],
    );
    frame = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: nonce as BufferSource, tagLength: 128 },
        aesKey,
        ct as BufferSource,
      ),
    );
  } catch {
    return null;
  }
  if (frame.length !== bucketSize) return null;
  const payloadLen = new DataView(frame.buffer, frame.byteOffset, 4).getUint32(0, true);
  if (payloadLen < 0 || FRAME_LEN_FIELD + payloadLen > bucketSize) return null;
  return frame.subarray(FRAME_LEN_FIELD, FRAME_LEN_FIELD + payloadLen);
}

/** §3.1 per-tx recipient derivation:
 *  `to = SHA-256("etchit-chainmark-v1/recipient" || nonce)[12:32]`.
 *  Returns a 0x-prefixed lowercase 20-byte hex address. */
export async function recipientForNonce(nonce: Uint8Array): Promise<string> {
  if (nonce.length !== NONCE_LEN) throw new Error(`nonce must be ${NONCE_LEN} bytes`);
  const buf = new Uint8Array(RECIPIENT_PREFIX_BYTES.length + NONCE_LEN);
  buf.set(RECIPIENT_PREFIX_BYTES, 0);
  buf.set(nonce, RECIPIENT_PREFIX_BYTES.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", buf as BufferSource));
  return `0x${hex(digest.subarray(12, 32))}`;
}

/** Convenience: derive the recipient straight from a sealed blob's
 *  header bytes. Used by indexer code that wants to verify
 *  `tx.to == recipientForBlob(tx.input)` before AEAD attempt. */
export async function recipientForBlob(blob: Uint8Array): Promise<string> {
  if (blob.length < 2 + NONCE_LEN) {
    throw new Error("blob too short for header");
  }
  return recipientForNonce(blob.subarray(2, 2 + NONCE_LEN));
}

function randomNonce(): Uint8Array {
  const n = new Uint8Array(NONCE_LEN);
  crypto.getRandomValues(n);
  return n;
}

function hex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}
