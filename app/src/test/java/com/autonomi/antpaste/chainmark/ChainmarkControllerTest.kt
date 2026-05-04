package com.autonomi.antpaste.chainmark

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ChainmarkControllerTest {

    private val A = "a".repeat(64)
    private val B = "b".repeat(64)
    private val key = ChainmarkCrypto.deriveKey(ByteArray(64))

    private fun add(addr: String, title: String, ts: Long) =
        WireEntry(WireEntry.KIND_PUBLIC, addr, title, ts, WireEntry.ACTION_ADD)

    private fun seal(entries: List<WireEntry>): ByteArray {
        val payload = ChainmarkPayload.encode(entries).toByteArray(Charsets.UTF_8)
        return ChainmarkCrypto.seal(key, payload)!!
    }

    @Test
    fun replay_emptyTxs_emptyState() {
        val state = ChainmarkController.replayDecryptedTxs(key, emptyList())
        assertTrue(state.isEmpty())
    }

    @Test
    fun replay_skipsForeignCalldata() {
        // Calldata that's not ours (random bytes) — must be silently skipped.
        val foreign = IndexedTx("0x1", 1, 0, ByteArray(1054) { 0x33 })
        val ours = IndexedTx("0x2", 2, 0, seal(listOf(add(A, "mine", 100))))
        val state = ChainmarkController.replayDecryptedTxs(key, listOf(foreign, ours))
        assertEquals(1, state.size)
        assertEquals("mine", state[A]!!.title)
    }

    @Test
    fun replay_appliesChainOrdering() {
        val older = IndexedTx("0x1", 1, 0, seal(listOf(add(A, "v1", 1))))
        val newer = IndexedTx("0x2", 5, 0, seal(listOf(add(A, "v2", 5))))
        val state = ChainmarkController.replayDecryptedTxs(key, listOf(newer, older))
        assertEquals("v2", state[A]!!.title)
    }

    @Test
    fun replay_multipleEtches() {
        val tx1 = IndexedTx("0x1", 1, 0, seal(listOf(add(A, "first", 1))))
        val tx2 = IndexedTx("0x2", 2, 0, seal(listOf(add(B, "second", 2))))
        val state = ChainmarkController.replayDecryptedTxs(key, listOf(tx1, tx2))
        assertEquals(2, state.size)
    }
}
