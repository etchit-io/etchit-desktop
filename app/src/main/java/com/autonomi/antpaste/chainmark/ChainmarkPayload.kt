package com.autonomi.antpaste.chainmark

import org.json.JSONArray
import org.json.JSONObject

// JSON codec for the chainmark payload (§9 of docs/chainmark-format-v1.md).
// Encoding is strict; decoding tolerates unknown fields and skips
// malformed/unknown-kind/unknown-action entries (spec requires silent skip).
object ChainmarkPayload {

    const val SCHEMA_VERSION = 1

    fun encode(entries: List<WireEntry>): String {
        val arr = JSONArray()
        for (e in entries) {
            require(e.kind in WireEntry.ALLOWED_KINDS) { "unknown kind: ${e.kind}" }
            require(e.action in WireEntry.ALLOWED_ACTIONS) { "unknown action: ${e.action}" }
            arr.put(JSONObject().apply {
                put("kind", e.kind)
                put("addr", e.addr)
                put("title", e.title)
                put("ts", e.ts)
                put("action", e.action)
            })
        }
        return JSONObject().apply {
            put("v", SCHEMA_VERSION)
            put("entries", arr)
        }.toString()
    }

    fun decode(json: String): List<WireEntry>? {
        val root = try { JSONObject(json) } catch (_: Exception) { return null }
        if (root.optInt("v", -1) != SCHEMA_VERSION) return null
        val arr = root.optJSONArray("entries") ?: return null
        val out = ArrayList<WireEntry>(arr.length())
        for (i in 0 until arr.length()) {
            val obj = arr.optJSONObject(i) ?: continue
            val kind = obj.optString("kind", "")
            if (kind !in WireEntry.ALLOWED_KINDS) continue
            val action = obj.optString("action", "")
            if (action !in WireEntry.ALLOWED_ACTIONS) continue
            val addr = obj.optString("addr", "")
            if (!isValidAddr(addr)) continue
            val title = obj.optString("title", "")
            if (title.toByteArray(Charsets.UTF_8).size > 256) continue
            if (!obj.has("ts")) continue
            val ts = obj.optLong("ts", Long.MIN_VALUE)
            if (ts == Long.MIN_VALUE) continue
            out += WireEntry(kind = kind, addr = addr, title = title, ts = ts, action = action)
        }
        return out
    }

    private fun isValidAddr(s: String): Boolean {
        if (s.length != 64) return false
        return s.all { it in '0'..'9' || it in 'a'..'f' }
    }
}
