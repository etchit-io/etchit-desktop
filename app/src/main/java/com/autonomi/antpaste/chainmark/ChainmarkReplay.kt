package com.autonomi.antpaste.chainmark

// Replays a sequence of decrypted on-chain chainmark batches into the canonical
// per-addr state per §11 of docs/chainmark-format-v1.md. Pure: no I/O, no
// time, no allocation beyond the result map.
object ChainmarkReplay {

    fun apply(events: List<TxEvent>): Map<String, ChainmarkEntry> {
        val sorted = events.sortedWith(compareBy({ it.blockNum }, { it.txIndex }))
        val state = LinkedHashMap<String, ChainmarkEntry>()
        for (event in sorted) {
            val entries = ChainmarkPayload.decode(event.payloadJson) ?: continue
            for (e in entries) applyEntry(state, e)
        }
        return state
    }

    private fun applyEntry(state: MutableMap<String, ChainmarkEntry>, e: WireEntry) {
        when (e.action) {
            WireEntry.ACTION_ADD -> {
                state[e.addr] = ChainmarkEntry(addr = e.addr, title = e.title, ts = e.ts, isBookmark = false, isHidden = false)
            }
            WireEntry.ACTION_BOOKMARK -> {
                state[e.addr] = ChainmarkEntry(addr = e.addr, title = e.title, ts = e.ts, isBookmark = true, isHidden = false)
            }
            WireEntry.ACTION_HIDE -> {
                val existing = state[e.addr]
                state[e.addr] = if (existing != null) existing.copy(isHidden = true)
                else ChainmarkEntry(addr = e.addr, title = "", ts = 0L, isBookmark = false, isHidden = true)
            }
        }
    }
}
