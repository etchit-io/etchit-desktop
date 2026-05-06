package com.autonomi.antpaste.chainmark

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class ChainmarkCryptoTest {

    private fun hex(s: String): ByteArray {
        val clean = s.removePrefix("0x")
        require(clean.length % 2 == 0)
        return ByteArray(clean.length / 2) {
            ((Character.digit(clean[it * 2], 16) shl 4) + Character.digit(clean[it * 2 + 1], 16)).toByte()
        }
    }

    private fun ByteArray.toHex(): String =
        joinToString("") { "%02x".format(it.toInt() and 0xff) }

    // ── RFC 5869 §A.3 (Test Case 3): empty salt, empty info, IKM = 0x0b*22 ──

    @Test
    fun hkdf_rfc5869_test3() {
        val ikm = hex("0b".repeat(22))
        val expected = hex(
            "8da4e775a563c18f715f802a063c5a31" +
            "b8a11f5c5ee1879ec3454e5f3c738d2d" +
            "9d201395faa4b61a96c8"
        )
        val out = ChainmarkCrypto.hkdfSha256(ByteArray(0), ikm, ByteArray(0), 42)
        assertArrayEquals(expected, out)
    }

    // ── deriveKey: golden values vs. an independent (Python) HKDF impl ──

    @Test
    fun deriveKey_zeroIkm_golden() {
        val ikm = ByteArray(64)
        val expected = hex("a69828cc3a40f916470270d58c2a4f8ec81bb9ccc332d05a2634f86e1c3d2c58")
        assertArrayEquals(expected, ChainmarkCrypto.deriveKey(ikm))
    }

    @Test
    fun deriveKey_filledIkm_golden() {
        val ikm = ByteArray(64) { 0x42 }
        val expected = hex("64a7f5fd165523dca68c1e5dc624b41de665006563b2ba3829f47e687dbd6d03")
        assertArrayEquals(expected, ChainmarkCrypto.deriveKey(ikm))
    }

    @Test(expected = IllegalArgumentException::class)
    fun deriveKey_rejectsWrongLength() {
        ChainmarkCrypto.deriveKey(ByteArray(32))
    }

    // ── selectBucket ──

    @Test
    fun selectBucket_boundaries() {
        assertEquals(0, ChainmarkCrypto.selectBucket(0))
        assertEquals(0, ChainmarkCrypto.selectBucket(1020))
        assertEquals(1, ChainmarkCrypto.selectBucket(1021))
        assertEquals(1, ChainmarkCrypto.selectBucket(4092))
        assertEquals(2, ChainmarkCrypto.selectBucket(4093))
        assertEquals(2, ChainmarkCrypto.selectBucket(16380))
        assertNull(ChainmarkCrypto.selectBucket(16381))
        assertNull(ChainmarkCrypto.selectBucket(-1))
    }

    // ── seal/open round-trip ──

    @Test
    fun sealOpen_emptyPayload() {
        val key = ByteArray(32) { 0x11 }
        val sealed = ChainmarkCrypto.seal(key, ByteArray(0))
        assertNotNull(sealed)
        assertEquals(2 + 12 + 1024 + 16, sealed!!.size)
        assertEquals(0x01.toByte(), sealed[0])
        assertEquals(0x00.toByte(), sealed[1])
        assertArrayEquals(ByteArray(0), ChainmarkCrypto.open(key, sealed))
    }

    @Test
    fun sealOpen_smallPayload_roundtrip() {
        val key = ByteArray(32) { 0x22 }
        val payload = """{"v":1,"entries":[]}""".toByteArray()
        val sealed = ChainmarkCrypto.seal(key, payload)!!
        assertEquals(0x00.toByte(), sealed[1])
        assertArrayEquals(payload, ChainmarkCrypto.open(key, sealed))
    }

    @Test
    fun sealOpen_4kPayload_roundtrip() {
        val key = ByteArray(32) { 0x33 }
        val payload = ByteArray(2000) { (it and 0xff).toByte() }
        val sealed = ChainmarkCrypto.seal(key, payload)!!
        assertEquals(0x01.toByte(), sealed[1])
        assertArrayEquals(payload, ChainmarkCrypto.open(key, sealed))
    }

    @Test
    fun sealOpen_16kPayload_roundtrip() {
        val key = ByteArray(32) { 0x44 }
        val payload = ByteArray(16000) { ((it * 7) and 0xff).toByte() }
        val sealed = ChainmarkCrypto.seal(key, payload)!!
        assertEquals(0x02.toByte(), sealed[1])
        assertArrayEquals(payload, ChainmarkCrypto.open(key, sealed))
    }

    @Test
    fun seal_rejectsOversizedPayload() {
        val key = ByteArray(32)
        assertNull(ChainmarkCrypto.seal(key, ByteArray(20000)))
    }

    @Test
    fun seal_explicitNonce_deterministic_golden() {
        val key = ChainmarkCrypto.deriveKey(ByteArray(64))
        val nonce = ByteArray(12)
        val payload = """{"v":1,"entries":[]}""".toByteArray()
        val sealed = ChainmarkCrypto.seal(key, payload, nonce)!!

        assertEquals(1054, sealed.size)
        // version + bucket_id
        assertEquals("0100", sealed.copyOfRange(0, 2).toHex())
        // nonce (zeros)
        assertEquals("000000000000000000000000", sealed.copyOfRange(2, 14).toHex())
        // first 32 bytes of ciphertext (deterministic vs the same Python AES-GCM impl)
        assertEquals(
            "a81854c3d6663b80db38018145d74b092f22bff74ab418e5e9742eab155d6843",
            sealed.copyOfRange(14, 46).toHex()
        )
        // last 16 bytes (the GCM tag)
        assertEquals(
            "77382661fee0d051d08ffdb0a9fc323f",
            sealed.copyOfRange(sealed.size - 16, sealed.size).toHex()
        )
    }

    // ── open: rejection paths ──

    @Test
    fun open_wrongKey_returnsNull() {
        val key = ByteArray(32) { 0x55 }
        val sealed = ChainmarkCrypto.seal(key, "hello".toByteArray())!!
        val wrongKey = ByteArray(32) { 0x66 }
        assertNull(ChainmarkCrypto.open(wrongKey, sealed))
    }

    @Test
    fun open_truncated_returnsNull() {
        val key = ByteArray(32) { 0x77 }
        val sealed = ChainmarkCrypto.seal(key, "hello".toByteArray())!!
        assertNull(ChainmarkCrypto.open(key, sealed.copyOfRange(0, sealed.size - 1)))
    }

    @Test
    fun open_wrongVersion_returnsNull() {
        val key = ByteArray(32) { 0x88.toByte() }
        val sealed = ChainmarkCrypto.seal(key, "hello".toByteArray())!!.also { it[0] = 0x02.toByte() }
        assertNull(ChainmarkCrypto.open(key, sealed))
    }

    @Test
    fun open_unknownBucketId_returnsNull() {
        val key = ByteArray(32) { 0x99.toByte() }
        val sealed = ChainmarkCrypto.seal(key, "hello".toByteArray())!!.also { it[1] = 0x05.toByte() }
        assertNull(ChainmarkCrypto.open(key, sealed))
    }

    @Test
    fun open_garbage_returnsNull() {
        val key = ByteArray(32) { 0xaa.toByte() }
        assertNull(ChainmarkCrypto.open(key, ByteArray(1054)))
    }
}
