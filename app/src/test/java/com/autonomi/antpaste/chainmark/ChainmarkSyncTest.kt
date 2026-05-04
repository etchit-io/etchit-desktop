package com.autonomi.antpaste.chainmark

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ChainmarkSyncTest {

    private val A = "a".repeat(64)

    private fun add(addr: String, title: String, ts: Long) =
        WireEntry(WireEntry.KIND_PUBLIC, addr, title, ts, WireEntry.ACTION_ADD)

    @Test
    fun planBatches_empty() {
        assertTrue(ChainmarkSync.planBatches(emptyList()).isEmpty())
    }

    @Test
    fun planBatches_singleEntry_oneBatch() {
        val plan = ChainmarkSync.planBatches(listOf(add(A, "x", 1)))
        assertEquals(1, plan.size)
        assertEquals(1, plan[0].size)
    }

    @Test
    fun planBatches_smallList_oneBatch() {
        val entries = (0 until 50).map { add(A, "title $it", it.toLong()) }
        val plan = ChainmarkSync.planBatches(entries)
        assertEquals(1, plan.size)
        assertEquals(50, plan[0].size)
    }

    @Test
    fun planBatches_manyEntriesWithLongTitles_splits() {
        val longTitle = "x".repeat(256)
        val entries = (0 until 200).map { add(A, longTitle, it.toLong()) }
        val plan = ChainmarkSync.planBatches(entries)
        assertTrue("expected multiple batches, got ${plan.size}", plan.size > 1)
        // Total entry count is preserved.
        assertEquals(200, plan.sumOf { it.size })
        // Every batch's encoded size fits in the 16 KiB bucket.
        for (batch in plan) {
            val size = ChainmarkPayload.encode(batch).toByteArray(Charsets.UTF_8).size + 4
            assertTrue("batch size $size > 16 KiB", size <= 16384)
        }
    }

    @Test
    fun planBatches_orderPreservedAcrossBatches() {
        val longTitle = "y".repeat(256)
        val entries = (0 until 100).map { add(A, longTitle, it.toLong()) }
        val plan = ChainmarkSync.planBatches(entries)
        val flat = plan.flatten()
        assertEquals(entries, flat)
    }
}
