package com.autonomi.antpaste.library

import android.util.Log
import com.autonomi.antpaste.wallet.WalletSigner

// Coordinates the v1 library state machine: set up (derive key) → restore from
// chain (fetch + decrypt + replay) → add/hide (single-entry self-tx) → forget.
// Stateless beyond the cached replayed map; no persistence beyond LibraryKeyManager.
class LibraryController(
    private val keyManager: LibraryKeyManager,
    private val indexer: IndexerClient,
    private val walletSigner: WalletSigner,
) {

    private val sync = LibrarySync(keyManager, walletSigner)

    @Volatile
    private var entries: Map<String, LibraryEntry> = emptyMap()

    @Volatile
    private var entriesLoadedFor: String? = null

    // Returns the in-memory replay state, but only if it was loaded for [walletAddress].
    // After a wallet switch, callers see an empty map until restoreFromChain runs again.
    fun entriesFor(walletAddress: String): Map<String, LibraryEntry> =
        if (entriesLoadedFor == walletAddress.lowercase()) entries else emptyMap()

    fun isSetUp(walletAddress: String): Boolean =
        keyManager.hasCachedKey(walletAddress)

    suspend fun setUp(chainId: String, walletAddress: String) {
        keyManager.deriveAndCache(chainId, walletAddress)
    }

    suspend fun restoreFromChain(walletAddress: String): Map<String, LibraryEntry> {
        val key = keyManager.getCachedKey(walletAddress)
            ?: throw IllegalStateException("library not set up for $walletAddress")
        Log.i(TAG, "restoreFromChain: wallet=$walletAddress")
        val txs = indexer.listLibraryTxs(walletAddress)
        Log.i(TAG, "restoreFromChain: indexer returned ${txs.size} candidate tx(s)")
        var decrypted = 0
        val events = txs.mapNotNull { tx ->
            val plaintext = LibraryCrypto.open(key, tx.calldata)
            if (plaintext == null) {
                Log.w(TAG, "restoreFromChain: AEAD reject hash=${tx.hash}")
                null
            } else {
                decrypted++
                TxEvent(tx.blockNum, tx.txIndex, String(plaintext, Charsets.UTF_8))
            }
        }
        val state = LibraryReplay.apply(events)
        Log.i(TAG, "restoreFromChain: decrypted=$decrypted → ${state.size} entr${if (state.size == 1) "y" else "ies"}")
        entries = state
        entriesLoadedFor = walletAddress.lowercase()
        return state
    }

    // Bulk-add: turns a list of (address, title) pairs into one or more sealed batches
    // and sends each as its own self-tx via planBatches() — ~130 small entries fit in
    // one 16 KiB batch for the cost of a single tx.
    suspend fun addMultiple(
        chainId: String,
        walletAddress: String,
        entries: List<Pair<String, String>>,
        action: String = WireEntry.ACTION_ADD,
    ): List<String> {
        require(entries.isNotEmpty()) { "no entries to add" }
        require(action == WireEntry.ACTION_ADD || action == WireEntry.ACTION_BOOKMARK) {
            "action must be add or bookmark"
        }
        val now = System.currentTimeMillis() / 1000
        val wire = entries.map { (addr, title) ->
            val normalized = addr.lowercase().removePrefix("0x")
            require(normalized.length == 64 && normalized.all { it in '0'..'9' || it in 'a'..'f' }) {
                "etch address must be 64 hex chars: $addr"
            }
            WireEntry(
                kind = WireEntry.KIND_PUBLIC,
                addr = normalized,
                title = title,
                ts = now,
                action = action,
            )
        }
        return LibrarySync.planBatches(wire).map { batch -> sync.sendBatch(chainId, walletAddress, batch) }
    }

    suspend fun addByAddress(
        chainId: String,
        walletAddress: String,
        etchAddr: String,
        title: String,
        action: String = WireEntry.ACTION_ADD,
    ): String {
        require(action == WireEntry.ACTION_ADD || action == WireEntry.ACTION_BOOKMARK) {
            "action must be add or bookmark"
        }
        val normalized = etchAddr.lowercase().removePrefix("0x")
        require(normalized.length == 64 && normalized.all { it in '0'..'9' || it in 'a'..'f' }) {
            "etch address must be 64 hex chars"
        }
        val entry = WireEntry(
            kind = WireEntry.KIND_PUBLIC,
            addr = normalized,
            title = title,
            ts = System.currentTimeMillis() / 1000,
            action = action,
        )
        return sync.sendBatch(chainId, walletAddress, listOf(entry))
    }

    suspend fun hide(chainId: String, walletAddress: String, etchAddr: String): String {
        val entry = WireEntry(
            kind = WireEntry.KIND_PUBLIC,
            addr = etchAddr.lowercase(),
            title = "",
            ts = 0L,
            action = WireEntry.ACTION_HIDE,
        )
        return sync.sendBatch(chainId, walletAddress, listOf(entry))
    }

    fun exportKey(walletAddress: String): ByteArray? =
        keyManager.getCachedKey(walletAddress)

    fun importKey(walletAddress: String, key: ByteArray) {
        keyManager.importKey(walletAddress, key)
    }

    fun forget(walletAddress: String) {
        keyManager.forget(walletAddress)
        if (entriesLoadedFor == walletAddress.lowercase()) {
            entries = emptyMap()
            entriesLoadedFor = null
        }
    }

    companion object {
        private const val TAG = "ant-paste"

        // Pure: decrypt-and-replay over an indexer's tx list. Skips txs whose
        // calldata fails AEAD verification (unrelated self-txs / wrong wallet).
        fun replayDecryptedTxs(key: ByteArray, txs: List<IndexedTx>): Map<String, LibraryEntry> {
            val events = txs.mapNotNull { tx ->
                val plaintext = LibraryCrypto.open(key, tx.calldata) ?: return@mapNotNull null
                TxEvent(tx.blockNum, tx.txIndex, String(plaintext, Charsets.UTF_8))
            }
            return LibraryReplay.apply(events)
        }
    }
}
