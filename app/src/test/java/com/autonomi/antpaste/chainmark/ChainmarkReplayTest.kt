package com.autonomi.antpaste.chainmark

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ChainmarkReplayTest {

    private val A = "a".repeat(64)
    private val B = "b".repeat(64)
    private val C = "c".repeat(64)

    private fun batch(blockNum: Long, txIndex: Int, vararg entries: WireEntry): TxEvent =
        TxEvent(blockNum, txIndex, ChainmarkPayload.encode(entries.toList()))

    private fun add(addr: String, title: String, ts: Long) =
        WireEntry(WireEntry.KIND_PUBLIC, addr, title, ts, WireEntry.ACTION_ADD)

    private fun bookmark(addr: String, title: String, ts: Long) =
        WireEntry(WireEntry.KIND_PUBLIC, addr, title, ts, WireEntry.ACTION_BOOKMARK)

    private fun hide(addr: String) =
        WireEntry(WireEntry.KIND_PUBLIC, addr, "", 0, WireEntry.ACTION_HIDE)

    @Test
    fun empty_input_emptyState() {
        assertEquals(emptyMap<String, ChainmarkEntry>(), ChainmarkReplay.apply(emptyList()))
    }

    @Test
    fun singleAdd_visibleNotBookmarked() {
        val state = ChainmarkReplay.apply(listOf(batch(1, 0, add(A, "hello", 100))))
        assertEquals(1, state.size)
        val e = state[A]!!
        assertEquals("hello", e.title)
        assertEquals(100, e.ts)
        assertFalse(e.isBookmark)
        assertFalse(e.isHidden)
    }

    @Test
    fun bookmark_distinguishedFromAdd() {
        val state = ChainmarkReplay.apply(listOf(batch(1, 0, bookmark(A, "foreign", 100))))
        assertTrue(state[A]!!.isBookmark)
    }

    @Test
    fun hideAfterAdd_marksHidden() {
        val state = ChainmarkReplay.apply(listOf(
            batch(1, 0, add(A, "x", 1)),
            batch(2, 0, hide(A)),
        ))
        val e = state[A]!!
        assertTrue(e.isHidden)
        assertEquals("x", e.title)
        assertEquals(1, e.ts)
    }

    @Test
    fun addAfterHide_unhides() {
        val state = ChainmarkReplay.apply(listOf(
            batch(1, 0, add(A, "v1", 1)),
            batch(2, 0, hide(A)),
            batch(3, 0, add(A, "v2", 3)),
        ))
        val e = state[A]!!
        assertFalse(e.isHidden)
        assertEquals("v2", e.title)
        assertEquals(3, e.ts)
    }

    @Test
    fun hideBeforeAdd_createsTombstone_thenUnhides() {
        val state = ChainmarkReplay.apply(listOf(
            batch(1, 0, hide(A)),
            batch(2, 0, add(A, "later", 5)),
        ))
        val e = state[A]!!
        assertFalse(e.isHidden)
        assertEquals("later", e.title)
    }

    @Test
    fun chainOrdering_winsOverInputOrder() {
        val state = ChainmarkReplay.apply(listOf(
            batch(3, 0, add(A, "v3", 30)),
            batch(1, 0, add(A, "v1", 10)),
            batch(2, 5, add(A, "v2", 20)),
        ))
        assertEquals("v3", state[A]!!.title)
    }

    @Test
    fun txIndex_breaksTiesWithinBlock() {
        val state = ChainmarkReplay.apply(listOf(
            batch(5, 9, add(A, "second", 2)),
            batch(5, 0, add(A, "first", 1)),
        ))
        assertEquals("second", state[A]!!.title)
    }

    @Test
    fun multipleEntries_perBatch_appliedInArrayOrder() {
        val state = ChainmarkReplay.apply(listOf(batch(1, 0, add(A, "first", 1), add(A, "second", 2))))
        assertEquals("second", state[A]!!.title)
    }

    @Test
    fun threeEtches_independentEntries() {
        val state = ChainmarkReplay.apply(listOf(batch(1, 0, add(A, "a", 1), add(B, "b", 2), bookmark(C, "c", 3))))
        assertEquals(3, state.size)
        assertFalse(state[A]!!.isBookmark)
        assertFalse(state[B]!!.isBookmark)
        assertTrue(state[C]!!.isBookmark)
    }

    @Test
    fun malformedBatch_skippedSilently() {
        val state = ChainmarkReplay.apply(listOf(
            batch(1, 0, add(A, "good", 1)),
            TxEvent(2, 0, "garbage not json"),
            batch(3, 0, add(B, "also good", 2)),
        ))
        assertEquals(2, state.size)
        assertEquals("good", state[A]!!.title)
        assertEquals("also good", state[B]!!.title)
    }

    @Test
    fun bookmarkThenAdd_promotesToOwn() {
        val state = ChainmarkReplay.apply(listOf(
            batch(1, 0, bookmark(A, "saw it elsewhere", 1)),
            batch(2, 0, add(A, "actually mine", 2)),
        ))
        assertFalse(state[A]!!.isBookmark)
    }

    @Test
    fun unknownEntry_inMixedBatch_skipped() {
        // Hand-crafted JSON mixing one valid + one private_backup (v2 reserved kind).
        val payload = """{"v":1,"entries":[
            {"kind":"private_backup","addr":"$A","title":"x","ts":1,"action":"add"},
            {"kind":"public","addr":"$B","title":"y","ts":2,"action":"add"}
        ]}""".trimIndent()
        val state = ChainmarkReplay.apply(listOf(TxEvent(1, 0, payload)))
        assertEquals(1, state.size)
        assertNull(state[A])
        assertEquals("y", state[B]!!.title)
    }
}
