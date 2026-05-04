package com.autonomi.antpaste.chainmark

import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

class ArbiscanIndexer(
    private val baseUrl: String = DEFAULT_BASE_URL,
    private val apiKey: String? = null,
) : IndexerClient {

    override suspend fun listChainmarkTxs(walletAddress: String): List<IndexedTx> = withContext(Dispatchers.IO) {
        val url = buildUrl(walletAddress)
        Log.i("ant-paste", "indexer GET ${url.replace(Regex("apikey=[^&]+"), "apikey=…")}")
        val raw = httpGet(url)
        Log.i("ant-paste", "indexer raw response: ${raw.length} bytes")
        val out = parseChainmarkTxs(raw, walletAddress)
        Log.i("ant-paste", "indexer parsed: ${out.size} chainmark tx(s) match recipient-derivation")
        if (out.isEmpty() && raw.contains("\"result\":[")) {
            // Diagnose: count how many txs the response had at all so we can tell
            // "indexer empty" from "all txs filtered out".
            try {
                val arr = JSONObject(raw).optJSONArray("result")
                val total = arr?.length() ?: 0
                Log.i("ant-paste", "indexer pre-filter total: $total tx(s) returned (none matched our shape)")
                if (arr != null) {
                    for (i in 0 until minOf(arr.length(), 5)) {
                        val tx = arr.optJSONObject(i) ?: continue
                        val from = tx.optString("from")
                        val to = tx.optString("to")
                        val value = tx.optString("value")
                        val inputLen = tx.optString("input").length
                        Log.i("ant-paste", "  tx[$i] from=${from.take(10)}… to=${to.take(10)}… value=$value inputHexLen=$inputLen")
                    }
                }
            } catch (_: Exception) {}
        }
        out
    }

    private fun buildUrl(walletAddress: String): String {
        // Etherscan-V1-style params. We deliberately omit startblock/endblock/page/offset:
        // BlockScout interprets endblock=99999999 literally and silently filters out any
        // tx with blockNumber > 99999999 (Arbitrum is well past that), returning empty.
        // Stock defaults work fine for any wallet whose history fits in a single response.
        val params = buildString {
            append("module=account&action=txlist")
            append("&address=").append(URLEncoder.encode(walletAddress, "UTF-8"))
            append("&sort=asc")
            if (!apiKey.isNullOrBlank()) append("&apikey=").append(URLEncoder.encode(apiKey, "UTF-8"))
        }
        return "$baseUrl?$params"
    }

    private fun httpGet(url: String): String {
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = 10_000
            readTimeout = 30_000
            setRequestProperty("Accept", "application/json")
        }
        try {
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val body = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
            if (code !in 200..299) throw RuntimeException("indexer HTTP $code: ${body.take(200)}")
            return body
        } finally {
            conn.disconnect()
        }
    }

    companion object {
        // Arbiscan retired their V1 API; V2 requires a paid API key. BlockScout's
        // Arbitrum mainnet instance speaks the same Etherscan-V1 query format,
        // is keyless, and is the default. Users can override via Settings to point
        // at Etherscan V2 or any other compatible indexer.
        const val DEFAULT_BASE_URL = "https://arbitrum.blockscout.com/api"

        // Pure: callable from tests with hand-authored Arbiscan responses.
        // Recipient verification: a tx is ours iff `to == recipientForBlob(input)` —
        // this is the spec-conformance check that AEAD then confirms.
        internal fun parseChainmarkTxs(rawJson: String, walletAddress: String): List<IndexedTx> {
            val from = walletAddress.lowercase()
            val root = try { JSONObject(rawJson) } catch (_: Exception) { return emptyList() }
            val arr = root.optJSONArray("result") ?: return emptyList()
            val out = ArrayList<IndexedTx>(arr.length())
            for (i in 0 until arr.length()) {
                val tx = arr.optJSONObject(i) ?: continue
                if (tx.optString("from").lowercase() != from) continue
                if (tx.optString("value") != "0") continue
                val input = tx.optString("input", "")
                if (input.isBlank() || input == "0x") continue
                val calldata = try { Hex.decode(input) } catch (_: Exception) { continue }
                if (calldata.size < 2 + ChainmarkCrypto.NONCE_LEN + ChainmarkCrypto.TAG_LEN) continue
                if (calldata[0] != ChainmarkCrypto.VERSION_BYTE) continue
                val expectedTo = try { ChainmarkCrypto.recipientForBlob(calldata) } catch (_: Exception) { continue }
                if (tx.optString("to").lowercase() != expectedTo.lowercase()) continue
                val blockNum = tx.optString("blockNumber").toLongOrNull() ?: continue
                val txIndex = tx.optString("transactionIndex").toIntOrNull() ?: continue
                val hash = tx.optString("hash", "")
                out += IndexedTx(hash, blockNum, txIndex, calldata)
            }
            return out
        }
    }
}
