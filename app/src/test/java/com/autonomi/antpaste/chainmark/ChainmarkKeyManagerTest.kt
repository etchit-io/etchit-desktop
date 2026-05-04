package com.autonomi.antpaste.chainmark

import org.junit.Assert.assertEquals
import org.junit.Test
import java.security.MessageDigest

class ChainmarkKeyManagerTest {

    // The SIGN_MESSAGE bytes are normative (spec §4.1). Changing them silently
    // invalidates every existing on-chain chainmark — this test guards against drift.
    @Test
    fun signMessage_matchesSpecBytes() {
        val bytes = ChainmarkKeyManager.SIGN_MESSAGE.toByteArray(Charsets.UTF_8)
        assertEquals(131, bytes.size)
        val sha = MessageDigest.getInstance("SHA-256").digest(bytes)
        val hex = sha.joinToString("") { "%02x".format(it.toInt() and 0xff) }
        assertEquals("ab6f4ae288e6053c3e2181c83e33065c870a8b58b76b1d6b0072aba658cecab0", hex)
    }

    @Test
    fun signMessage_endsWithoutNewline() {
        val bytes = ChainmarkKeyManager.SIGN_MESSAGE.toByteArray(Charsets.UTF_8)
        assertEquals('.'.code.toByte(), bytes[bytes.size - 1])
    }
}
