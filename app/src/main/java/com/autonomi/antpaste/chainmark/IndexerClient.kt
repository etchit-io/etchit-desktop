package com.autonomi.antpaste.chainmark

interface IndexerClient {
    // Returns all txs where from == [walletAddress] and to == ChainmarkCrypto.SENTINEL_ADDRESS
    // and value == 0, in any order — caller sorts. Implementations MAY return more txs
    // (replay tolerates unrelated calldata via AEAD failure). Throws on transport / parse failure.
    suspend fun listChainmarkTxs(walletAddress: String): List<IndexedTx>
}

data class IndexedTx(
    val hash: String,
    val blockNum: Long,
    val txIndex: Int,
    val calldata: ByteArray,
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is IndexedTx) return false
        return hash == other.hash &&
            blockNum == other.blockNum &&
            txIndex == other.txIndex &&
            calldata.contentEquals(other.calldata)
    }

    override fun hashCode(): Int {
        var r = hash.hashCode()
        r = 31 * r + blockNum.hashCode()
        r = 31 * r + txIndex
        r = 31 * r + calldata.contentHashCode()
        return r
    }
}
