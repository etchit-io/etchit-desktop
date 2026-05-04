package com.autonomi.antpaste.chainmark

// Tiny hex helpers, kept inside the chainmark package so it doesn't depend
// on `wallet/Erc20`'s internal helpers.
internal object Hex {
    fun encode(bytes: ByteArray): String =
        bytes.joinToString("") { "%02x".format(it.toInt() and 0xff) }

    fun decode(hex: String): ByteArray {
        val clean = hex.removePrefix("0x")
        require(clean.length % 2 == 0) { "hex string must have even length" }
        return ByteArray(clean.length / 2) { i ->
            val hi = Character.digit(clean[i * 2], 16)
            val lo = Character.digit(clean[i * 2 + 1], 16)
            require(hi >= 0 && lo >= 0) { "non-hex char in input" }
            ((hi shl 4) + lo).toByte()
        }
    }
}
