package com.autonomi.antpaste.vault

import android.content.SharedPreferences
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import uniffi.ant_ffi.PaymentEntry
import java.math.BigInteger

// Snapshot of an in-flight etch that persists across process death so a
// retry after a crash/kill can finalize without re-quoting or re-paying.
// `paidTxHash` is the load-bearing field — once a payment is confirmed
// on-chain we MUST persist it durably (commit, not apply) so a kill
// before the finalize completes doesn't lose the receipt and double-charge.
data class ResumableEtch(
    val prepared: EtchSigner.PreparedEtch,
    val approveBudget: BigInteger,
    val title: String,
    val content: String,
    val isBackup: Boolean = false,
    /** Hash of a prior successful `payForQuotes` for this prepared upload,
     *  captured the moment the receipt confirmed. When set, retry passes
     *  it to `signAndFinalize` to skip the wallet flow and avoid charging
     *  twice. */
    val paidTxHash: String? = null,
)

// Reads/writes the encrypted-prefs blob holding the latest ResumableEtch.
// Owns the in-memory `current` state and the durable persistence — host
// activity goes through this rather than touching SharedPreferences directly.
class ResumableEtchStore(
    private val prefs: SharedPreferences,
) {
    var current: ResumableEtch? = null
        private set

    // Update both in-memory and disk. `durable=true` forces a synchronous
    // commit() — losing this write to a kill-during-async-flush is the
    // exact failure mode the persistence is meant to prevent (relevant
    // when capturing paidTxHash). For non-critical updates apply() is fine.
    fun set(value: ResumableEtch?, durable: Boolean = false) {
        current = value
        try {
            val editor = prefs.edit()
            if (value == null) editor.remove(KEY)
            else editor.putString(KEY, value.toJsonString())
            if (durable) editor.commit() else editor.apply()
        } catch (e: Exception) {
            // In-memory field is still correct; only resume-after-death is at risk.
            Log.e("ant-paste", "ResumableEtchStore.set persist failed: ${e.message}", e)
        }
    }

    // Hydrate in-memory state from a value already known to be on disk
    // (no-op for persistence). Used at process start after loadPersisted
    // returns a value the user resumed from.
    fun restore(value: ResumableEtch?) {
        current = value
    }

    // Read any persisted pending etch from a prior process. Returns null
    // if none, malformed, or older than MAX_AGE_MS.
    fun loadPersisted(): ResumableEtch? {
        val json = try {
            prefs.getString(KEY, null)
        } catch (e: Exception) {
            Log.w("ant-paste", "ResumableEtchStore.loadPersisted: prefs read failed: ${e.message}")
            return null
        } ?: return null

        val parsed = parseResumableEtchJson(json) ?: run {
            Log.w("ant-paste", "ResumableEtchStore.loadPersisted: parse failed, clearing")
            prefs.edit().remove(KEY).apply()
            return null
        }

        val ageMs = System.currentTimeMillis() - parsed.prepared.createdAtMs
        if (ageMs > MAX_AGE_MS) {
            Log.i("ant-paste", "ResumableEtchStore.loadPersisted: discarding stale (age=${ageMs / 1000 / 60}m)")
            prefs.edit().remove(KEY).apply()
            return null
        }
        return parsed
    }

    companion object {
        // Suffix forces older payloads to be ignored after schema changes.
        private const val KEY = "pending_etch_state_v1"
        private const val MAX_AGE_MS = 24L * 60L * 60L * 1000L
    }
}

private fun ResumableEtch.toJsonString(): String {
    val paymentsArr = JSONArray()
    prepared.payments.forEach { p ->
        paymentsArr.put(JSONObject().apply {
            put("quote_hash", p.quoteHash)
            put("rewards_address", p.rewardsAddress)
            put("amount", p.amount)
        })
    }
    val preparedJson = JSONObject().apply {
        put("uploadId", prepared.uploadId)
        put("totalAmountStr", prepared.totalAmountStr)
        put("publicAddress", prepared.publicAddress ?: JSONObject.NULL)
        put("privateDataMap", prepared.privateDataMap ?: JSONObject.NULL)
        put("isPrivate", prepared.isPrivate)
        put("dataSize", prepared.dataSize)
        put("createdAtMs", prepared.createdAtMs)
        put("payments", paymentsArr)
    }
    return JSONObject().apply {
        put("schema", 1)
        put("title", title)
        put("content", content)
        put("approveBudget", approveBudget.toString())
        put("isBackup", isBackup)
        put("paidTxHash", paidTxHash ?: JSONObject.NULL)
        put("prepared", preparedJson)
    }.toString()
}

private fun parseResumableEtchJson(json: String): ResumableEtch? = try {
    val obj = JSONObject(json)
    val preparedObj = obj.getJSONObject("prepared")
    val paymentsArr = preparedObj.getJSONArray("payments")
    val payments = (0 until paymentsArr.length()).map { i ->
        val p = paymentsArr.getJSONObject(i)
        PaymentEntry(
            quoteHash = p.getString("quote_hash"),
            rewardsAddress = p.getString("rewards_address"),
            amount = p.getString("amount"),
        )
    }
    val totalAmountStr = preparedObj.getString("totalAmountStr")
    val prepared = EtchSigner.PreparedEtch(
        uploadId = preparedObj.getString("uploadId"),
        payments = payments,
        totalAmountStr = totalAmountStr,
        totalAtto = BigInteger(totalAmountStr),
        publicAddress = preparedObj.optStringOrNull("publicAddress"),
        privateDataMap = preparedObj.optStringOrNull("privateDataMap"),
        isPrivate = preparedObj.getBoolean("isPrivate"),
        dataSize = preparedObj.getInt("dataSize"),
        createdAtMs = preparedObj.getLong("createdAtMs"),
    )
    ResumableEtch(
        prepared = prepared,
        approveBudget = BigInteger(obj.getString("approveBudget")),
        title = obj.getString("title"),
        content = obj.getString("content"),
        isBackup = obj.optBoolean("isBackup", false),
        paidTxHash = obj.optStringOrNull("paidTxHash"),
    )
} catch (e: Exception) {
    Log.w("ant-paste", "parseResumableEtchJson failed: ${e.message}", e)
    null
}

private fun JSONObject.optStringOrNull(key: String): String? =
    if (isNull(key) || !has(key)) null else optString(key).takeIf { it.isNotEmpty() }
