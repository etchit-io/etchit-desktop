package com.autonomi.antpaste.chainmark

import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

// Implements §4–§8 of docs/chainmark-format-v1.md. Pure JVM, no Android deps —
// must round-trip byte-identically against any other v1-conformant client.
object ChainmarkCrypto {

    const val VERSION_BYTE: Byte = 0x01
    const val NONCE_LEN = 12
    const val TAG_LEN = 16
    const val KEY_LEN = 32
    const val IKM_LEN = 64

    val BUCKETS = intArrayOf(1024, 4096, 16384)

    private const val RECIPIENT_PREFIX = "etchit-chainmark-v1/recipient"

    private const val GCM_TAG_BITS = 128
    private const val FRAME_LEN_FIELD = 4
    private const val INFO = "etchit-chainmark/v1/aead-key"

    fun deriveKey(ikm: ByteArray): ByteArray {
        require(ikm.size == IKM_LEN) { "IKM must be $IKM_LEN bytes (r||s of personal_sign signature)" }
        return hkdfSha256(ByteArray(0), ikm, INFO.toByteArray(Charsets.US_ASCII), KEY_LEN)
    }

    fun seal(key: ByteArray, payload: ByteArray, nonce: ByteArray? = null): ByteArray? {
        require(key.size == KEY_LEN) { "key must be $KEY_LEN bytes" }
        val bucketId = selectBucket(payload.size) ?: return null
        val bucketSize = BUCKETS[bucketId]

        val frame = ByteArray(bucketSize)
        ByteBuffer.wrap(frame, 0, FRAME_LEN_FIELD).order(ByteOrder.LITTLE_ENDIAN).putInt(payload.size)
        System.arraycopy(payload, 0, frame, FRAME_LEN_FIELD, payload.size)

        val n = nonce ?: ByteArray(NONCE_LEN).also { SecureRandom().nextBytes(it) }
        require(n.size == NONCE_LEN) { "nonce must be $NONCE_LEN bytes" }

        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(GCM_TAG_BITS, n))
        val ct = cipher.doFinal(frame)

        val blob = ByteArray(2 + NONCE_LEN + ct.size)
        blob[0] = VERSION_BYTE
        blob[1] = bucketId.toByte()
        System.arraycopy(n, 0, blob, 2, NONCE_LEN)
        System.arraycopy(ct, 0, blob, 2 + NONCE_LEN, ct.size)
        return blob
    }

    fun open(key: ByteArray, blob: ByteArray): ByteArray? {
        if (key.size != KEY_LEN) return null
        if (blob.size < 2 + NONCE_LEN + TAG_LEN) return null
        if (blob[0] != VERSION_BYTE) return null
        val bucketId = blob[1].toInt() and 0xff
        if (bucketId !in BUCKETS.indices) return null
        val bucketSize = BUCKETS[bucketId]
        if (blob.size != 2 + NONCE_LEN + bucketSize + TAG_LEN) return null

        val nonce = blob.copyOfRange(2, 2 + NONCE_LEN)
        val ct = blob.copyOfRange(2 + NONCE_LEN, blob.size)

        val frame = try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(GCM_TAG_BITS, nonce))
            cipher.doFinal(ct)
        } catch (_: Exception) {
            return null
        }
        if (frame.size != bucketSize) return null

        val payloadLen = ByteBuffer.wrap(frame, 0, FRAME_LEN_FIELD).order(ByteOrder.LITTLE_ENDIAN).int
        if (payloadLen < 0 || FRAME_LEN_FIELD + payloadLen > bucketSize) return null
        return frame.copyOfRange(FRAME_LEN_FIELD, FRAME_LEN_FIELD + payloadLen)
    }

    // Per-tx recipient: SHA-256("etchit-chainmark-v1/recipient" || nonce)[12:32].
    // Fresh address per tx (nonce is CSPRNG-random) so chain observers cannot
    // enumerate chainmark activity via a single `to == X` filter. Provably
    // unowned (2^-160 collision with any keccak-derived EOA address).
    fun recipientForNonce(nonce: ByteArray): String {
        require(nonce.size == NONCE_LEN) { "nonce must be $NONCE_LEN bytes" }
        val md = MessageDigest.getInstance("SHA-256")
        md.update(RECIPIENT_PREFIX.toByteArray(Charsets.US_ASCII))
        md.update(nonce)
        val digest = md.digest()
        return "0x" + digest.copyOfRange(12, 32).joinToString("") { "%02x".format(it.toInt() and 0xff) }
    }

    // Convenience: derive the recipient directly from a sealed blob's header.
    fun recipientForBlob(blob: ByteArray): String {
        require(blob.size >= 2 + NONCE_LEN) { "blob too short for header" }
        return recipientForNonce(blob.copyOfRange(2, 2 + NONCE_LEN))
    }

    fun selectBucket(payloadLen: Int): Int? {
        if (payloadLen < 0) return null
        val needed = FRAME_LEN_FIELD + payloadLen
        BUCKETS.forEachIndexed { i, size -> if (needed <= size) return i }
        return null
    }

    // RFC 5869 inlined — keeps deps minimal and is the same ~20 lines any Rust/JS port
    // implements directly. Internal so tests can verify against published vectors.
    internal fun hkdfSha256(salt: ByteArray, ikm: ByteArray, info: ByteArray, length: Int): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        val effectiveSalt = if (salt.isEmpty()) ByteArray(mac.macLength) else salt
        mac.init(SecretKeySpec(effectiveSalt, "HmacSHA256"))
        val prk = mac.doFinal(ikm)

        mac.init(SecretKeySpec(prk, "HmacSHA256"))
        val out = ByteArray(length)
        var t = ByteArray(0)
        var pos = 0
        var counter: Byte = 1
        while (pos < length) {
            mac.reset()
            mac.update(t)
            mac.update(info)
            mac.update(counter)
            t = mac.doFinal()
            val toCopy = minOf(t.size, length - pos)
            System.arraycopy(t, 0, out, pos, toCopy)
            pos += toCopy
            counter++
        }
        return out
    }
}
