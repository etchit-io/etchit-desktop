package com.autonomi.antpaste.chainmark

// Wire-format entry as it appears in the JSON payload (§9 of docs/chainmark-format-v1.md).
data class WireEntry(
    val kind: String,
    val addr: String,
    val title: String,
    val ts: Long,
    val action: String,
) {
    companion object {
        const val KIND_PUBLIC = "public"
        const val ACTION_ADD = "add"
        const val ACTION_HIDE = "hide"
        const val ACTION_BOOKMARK = "bookmark"

        val ALLOWED_KINDS = setOf(KIND_PUBLIC)
        val ALLOWED_ACTIONS = setOf(ACTION_ADD, ACTION_HIDE, ACTION_BOOKMARK)
    }
}

// Canonical state for one etch after replay.
data class ChainmarkEntry(
    val addr: String,
    val title: String,
    val ts: Long,
    val isBookmark: Boolean,
    val isHidden: Boolean,
)

// One on-chain tx contributing to the chainmark replay.
data class TxEvent(
    val blockNum: Long,
    val txIndex: Int,
    val payloadJson: String,
)
