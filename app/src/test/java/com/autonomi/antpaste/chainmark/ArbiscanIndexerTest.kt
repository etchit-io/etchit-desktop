package com.autonomi.antpaste.chainmark

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ArbiscanIndexerTest {

    private val WALLET = "0xabcdef0123456789abcdef0123456789abcdef01"
    private val key = ChainmarkCrypto.deriveKey(ByteArray(64))

    private fun blob(nonceFill: Int = 0x77): ByteArray {
        val n = ByteArray(12) { nonceFill.toByte() }
        return ChainmarkCrypto.seal(key, "x".toByteArray(), nonce = n)!!
    }

    private fun toHex(b: ByteArray) = "0x" + b.joinToString("") { "%02x".format(it.toInt() and 0xff) }

    private val SEALED = blob()
    private val MATCHING_TO = ChainmarkCrypto.recipientForBlob(SEALED)

    private fun txJson(
        from: String = WALLET,
        to: String = MATCHING_TO,
        value: String = "0",
        input: String = toHex(SEALED),
        blockNumber: String = "100",
        txIndex: String = "0",
        hash: String = "0x" + "1".repeat(64),
    ) = """{"blockNumber":"$blockNumber","transactionIndex":"$txIndex","hash":"$hash","from":"$from","to":"$to","value":"$value","input":"$input"}"""

    private fun txJsonForBlob(b: ByteArray, blockNumber: String = "100"): String {
        return txJson(input = toHex(b), to = ChainmarkCrypto.recipientForBlob(b), blockNumber = blockNumber)
    }

    private fun response(vararg txs: String) =
        """{"status":"1","message":"OK","result":[${txs.joinToString(",")}]}"""

    @Test
    fun parses_simpleChainmarkTx() {
        val txs = ArbiscanIndexer.parseChainmarkTxs(response(txJson()), WALLET)
        assertEquals(1, txs.size)
        assertEquals(100L, txs[0].blockNum)
        assertEquals(0, txs[0].txIndex)
        assertArrayEquals(SEALED, txs[0].calldata)
    }

    @Test
    fun filtersOut_wrongFrom() {
        val notMine = txJson(from = "0x" + "1".repeat(40))
        val mine = txJson()
        val txs = ArbiscanIndexer.parseChainmarkTxs(response(notMine, mine), WALLET)
        assertEquals(1, txs.size)
    }

    @Test
    fun filtersOut_nonZeroValue() {
        val withValue = txJson(value = "1000000000000000000")
        val zero = txJson()
        val txs = ArbiscanIndexer.parseChainmarkTxs(response(withValue, zero), WALLET)
        assertEquals(1, txs.size)
    }

    @Test
    fun filtersOut_emptyInput() {
        val empty1 = txJson(input = "")
        val empty2 = txJson(input = "0x")
        val real = txJson()
        val txs = ArbiscanIndexer.parseChainmarkTxs(response(empty1, empty2, real), WALLET)
        assertEquals(1, txs.size)
    }

    @Test
    fun filtersOut_wrongRecipient() {
        val wrongTo = txJson(to = "0x" + "0".repeat(40))
        val txs = ArbiscanIndexer.parseChainmarkTxs(response(wrongTo), WALLET)
        assertTrue(txs.isEmpty())
    }

    @Test
    fun filtersOut_wrongVersionByte() {
        val tampered = SEALED.copyOf().apply { this[0] = 0x02 }
        val tx = txJson(input = toHex(tampered), to = ChainmarkCrypto.recipientForBlob(tampered))
        val txs = ArbiscanIndexer.parseChainmarkTxs(response(tx), WALLET)
        assertTrue(txs.isEmpty())
    }

    @Test
    fun filtersOut_truncatedCalldata() {
        val short = txJson(input = "0x010001020304")
        val txs = ArbiscanIndexer.parseChainmarkTxs(response(short), WALLET)
        assertTrue(txs.isEmpty())
    }

    @Test
    fun preservesOrder_asReturnedByIndexer() {
        val a = txJsonForBlob(blob(0x01), blockNumber = "5")
        val b = txJsonForBlob(blob(0x02), blockNumber = "1")
        val c = txJsonForBlob(blob(0x03), blockNumber = "3")
        val txs = ArbiscanIndexer.parseChainmarkTxs(response(a, b, c), WALLET)
        assertEquals(listOf(5L, 1L, 3L), txs.map { it.blockNum })
    }

    @Test
    fun handlesMixedCaseAddresses() {
        val mixedFrom = txJson(from = WALLET.uppercase())
        val mixedTo = txJson(to = MATCHING_TO.uppercase())
        val txs = ArbiscanIndexer.parseChainmarkTxs(response(mixedFrom, mixedTo), WALLET)
        assertEquals(2, txs.size)
    }

    @Test
    fun emptyResult_returnsEmpty() {
        val txs = ArbiscanIndexer.parseChainmarkTxs(response(), WALLET)
        assertTrue(txs.isEmpty())
    }

    @Test
    fun arbiscanNoTxsFound_returnsEmpty() {
        val raw = """{"status":"0","message":"No transactions found","result":[]}"""
        val txs = ArbiscanIndexer.parseChainmarkTxs(raw, WALLET)
        assertTrue(txs.isEmpty())
    }

    @Test
    fun garbageJson_returnsEmpty() {
        assertTrue(ArbiscanIndexer.parseChainmarkTxs("not json", WALLET).isEmpty())
        assertTrue(ArbiscanIndexer.parseChainmarkTxs("", WALLET).isEmpty())
    }

    @Test
    fun resultMissing_returnsEmpty() {
        assertTrue(ArbiscanIndexer.parseChainmarkTxs("""{"status":"1"}""", WALLET).isEmpty())
    }
}
