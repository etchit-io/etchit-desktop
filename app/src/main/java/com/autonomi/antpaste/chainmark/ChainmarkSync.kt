package com.autonomi.antpaste.chainmark

import com.autonomi.antpaste.wallet.WalletSigner
import java.math.BigInteger

class ChainmarkSync(
    private val keyManager: ChainmarkKeyManager,
    private val walletSigner: WalletSigner,
) {

    // Sends one chainmark batch as a self-tx. Caller is responsible for chunking
    // a large entry list with planBatches() — each call here = one wallet prompt.
    // Returns the transaction hash on success.
    suspend fun sendBatch(
        chainId: String,
        walletAddress: String,
        entries: List<WireEntry>,
    ): String {
        require(entries.isNotEmpty()) { "no entries to send" }
        val key = keyManager.getCachedKey(walletAddress)
            ?: throw IllegalStateException("chainmark key not derived — call ChainmarkKeyManager.deriveAndCache first")
        val payload = ChainmarkPayload.encode(entries).toByteArray(Charsets.UTF_8)
        val blob = ChainmarkCrypto.seal(key, payload)
            ?: throw IllegalArgumentException("batch too large for max bucket (${ChainmarkCrypto.BUCKETS.last()} bytes) — call planBatches() to split")
        return walletSigner.sendTransaction(
            chainId = chainId,
            from = walletAddress,
            to = ChainmarkCrypto.recipientForBlob(blob),
            data = blob,
            value = BigInteger.ZERO,
        )
    }

    companion object {
        // Greedy split: appends entries one at a time, opens a new batch when the next
        // entry would push the encoded payload past the 16 KiB bucket. Pure — UI can
        // call this before prompting the user so the cost preview is accurate.
        fun planBatches(entries: List<WireEntry>): List<List<WireEntry>> {
            if (entries.isEmpty()) return emptyList()
            val maxBucket = ChainmarkCrypto.BUCKETS.last()
            val batches = mutableListOf<List<WireEntry>>()
            var current = mutableListOf<WireEntry>()
            for (entry in entries) {
                current.add(entry)
                if (encodedSize(current) > maxBucket) {
                    if (current.size == 1) {
                        throw IllegalArgumentException("single entry exceeds max bucket — title too long?")
                    }
                    current.removeAt(current.size - 1)
                    batches.add(current)
                    current = mutableListOf(entry)
                }
            }
            if (current.isNotEmpty()) batches.add(current)
            return batches
        }

        private fun encodedSize(entries: List<WireEntry>): Int =
            ChainmarkPayload.encode(entries).toByteArray(Charsets.UTF_8).size + 4 // +4 for plaintext length-field header
    }
}
