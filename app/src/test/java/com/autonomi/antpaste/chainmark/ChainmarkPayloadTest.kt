package com.autonomi.antpaste.chainmark

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ChainmarkPayloadTest {

    private val A = "a".repeat(64)
    private val B = "b".repeat(64)

    private fun add(addr: String, title: String, ts: Long) =
        WireEntry(WireEntry.KIND_PUBLIC, addr, title, ts, WireEntry.ACTION_ADD)

    @Test
    fun encode_emptyEntries() {
        val s = ChainmarkPayload.encode(emptyList())
        val obj = JSONObject(s)
        assertEquals(1, obj.getInt("v"))
        assertEquals(0, obj.getJSONArray("entries").length())
    }

    @Test
    fun encode_singleEntry_shape() {
        val s = ChainmarkPayload.encode(listOf(add(A, "hello", 1714572800)))
        val obj = JSONObject(s)
        val arr = obj.getJSONArray("entries")
        assertEquals(1, arr.length())
        val e = arr.getJSONObject(0)
        assertEquals("public", e.getString("kind"))
        assertEquals(A, e.getString("addr"))
        assertEquals("hello", e.getString("title"))
        assertEquals(1714572800L, e.getLong("ts"))
        assertEquals("add", e.getString("action"))
    }

    @Test
    fun encodeDecode_roundtrip() {
        val originals = listOf(
            add(A, "first", 100),
            WireEntry(WireEntry.KIND_PUBLIC, B, "second", 200, WireEntry.ACTION_BOOKMARK),
            WireEntry(WireEntry.KIND_PUBLIC, A, "", 300, WireEntry.ACTION_HIDE),
        )
        val s = ChainmarkPayload.encode(originals)
        val decoded = ChainmarkPayload.decode(s)
        assertNotNull(decoded)
        assertEquals(originals, decoded)
    }

    @Test
    fun decode_garbage_returnsNull() {
        assertNull(ChainmarkPayload.decode(""))
        assertNull(ChainmarkPayload.decode("not json"))
        assertNull(ChainmarkPayload.decode("[]"))
    }

    @Test
    fun decode_wrongVersion_returnsNull() {
        assertNull(ChainmarkPayload.decode("""{"v":2,"entries":[]}"""))
    }

    @Test
    fun decode_skipsUnknownKind() {
        val s = """{"v":1,"entries":[
            {"kind":"private_backup","addr":"$A","title":"x","ts":1,"action":"add"},
            {"kind":"public","addr":"$B","title":"y","ts":2,"action":"add"}
        ]}""".trimIndent()
        val decoded = ChainmarkPayload.decode(s)!!
        assertEquals(1, decoded.size)
        assertEquals(B, decoded[0].addr)
    }

    @Test
    fun decode_skipsUnknownAction() {
        val s = """{"v":1,"entries":[
            {"kind":"public","addr":"$A","title":"x","ts":1,"action":"delete"},
            {"kind":"public","addr":"$B","title":"y","ts":2,"action":"add"}
        ]}""".trimIndent()
        val decoded = ChainmarkPayload.decode(s)!!
        assertEquals(1, decoded.size)
        assertEquals(B, decoded[0].addr)
    }

    @Test
    fun decode_skipsBadAddr() {
        val s = """{"v":1,"entries":[
            {"kind":"public","addr":"too-short","title":"x","ts":1,"action":"add"},
            {"kind":"public","addr":"${A.uppercase()}","title":"x","ts":2,"action":"add"},
            {"kind":"public","addr":"$B","title":"y","ts":3,"action":"add"}
        ]}""".trimIndent()
        val decoded = ChainmarkPayload.decode(s)!!
        assertEquals(1, decoded.size)
        assertEquals(B, decoded[0].addr)
    }

    @Test
    fun decode_skipsOversizedTitle() {
        val tooBig = "x".repeat(257)
        val s = """{"v":1,"entries":[
            {"kind":"public","addr":"$A","title":"$tooBig","ts":1,"action":"add"},
            {"kind":"public","addr":"$B","title":"ok","ts":2,"action":"add"}
        ]}""".trimIndent()
        val decoded = ChainmarkPayload.decode(s)!!
        assertEquals(1, decoded.size)
        assertEquals(B, decoded[0].addr)
    }

    @Test
    fun decode_ignoresUnknownTopLevelFields() {
        val s = """{"v":1,"entries":[],"extra":"ignored","more":42}"""
        val decoded = ChainmarkPayload.decode(s)
        assertNotNull(decoded)
        assertTrue(decoded!!.isEmpty())
    }

    @Test(expected = IllegalArgumentException::class)
    fun encode_rejectsUnknownKind() {
        ChainmarkPayload.encode(listOf(WireEntry("private_backup", A, "x", 1, "add")))
    }

    @Test(expected = IllegalArgumentException::class)
    fun encode_rejectsUnknownAction() {
        ChainmarkPayload.encode(listOf(WireEntry("public", A, "x", 1, "delete")))
    }
}
