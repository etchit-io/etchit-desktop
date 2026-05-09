package com.autonomi.antpaste.ui

import android.app.Activity
import android.app.AlertDialog
import android.graphics.Typeface
import android.text.TextUtils
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.widget.NestedScrollView
import com.autonomi.antpaste.EtchHistory
import com.autonomi.antpaste.MainActivity
import com.autonomi.antpaste.R
import com.autonomi.antpaste.chainmark.ChainmarkController
import com.autonomi.antpaste.chainmark.WireEntry
import com.autonomi.antpaste.wallet.SessionState
import com.autonomi.antpaste.wallet.WalletSession
import com.google.android.material.bottomsheet.BottomSheetDialog
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

// Bottom-sheet listing of past etches with per-row actions: tap to copy
// the address, long-press for fetch / add-to-chainmarks / remove.
fun showEtchHistory(
    activity: Activity,
    etchHistory: EtchHistory,
    walletSession: WalletSession,
    chainmarkController: ChainmarkController,
    lifecycleScope: CoroutineScope,
    onCopy: (text: String, label: String) -> Unit,
    onShowStatus: (msg: String, isError: Boolean) -> Unit,
    onFetchPublic: (address: String) -> Unit,
    onFetchPrivate: (dataMapId: String) -> Unit,
) {
    val dialog = BottomSheetDialog(activity, R.style.SheetDialog)
    val dp = activity.resources.displayMetrics.density
    val pad = (24 * dp).toInt()

    val root = LinearLayout(activity).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(pad, pad, pad, pad)
        setBackgroundColor(MainActivity.INK)
    }

    val title = TextView(activity).apply {
        text = "Etch History"
        setTextColor(MainActivity.BONE)
        textSize = 20f
        setTypeface(typeface, Typeface.BOLD)
        val mb = (16 * dp).toInt()
        layoutParams = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT,
        ).apply { bottomMargin = mb }
    }
    root.addView(title)

    val entries = etchHistory.load()
    if (entries.isEmpty()) {
        root.addView(TextView(activity).apply {
            text = "No etches yet"
            setTextColor(MainActivity.ASH)
            textSize = 13f
        })
    } else {
        val dateFormat = SimpleDateFormat("MMM d, yyyy  HH:mm", Locale.getDefault())
        val container = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }

        for (entry in entries) {
            val row = buildHistoryRow(
                activity = activity,
                entry = entry,
                dateFormat = dateFormat,
                container = container,
                dialog = dialog,
                etchHistory = etchHistory,
                walletSession = walletSession,
                chainmarkController = chainmarkController,
                lifecycleScope = lifecycleScope,
                onCopy = onCopy,
                onShowStatus = onShowStatus,
                onFetchPublic = onFetchPublic,
                onFetchPrivate = onFetchPrivate,
            )
            container.addView(row)
        }
        root.addView(container)

        val clearBtn = TextView(activity).apply {
            text = "Clear history"
            setTextColor(MainActivity.STATUS_RED)
            textSize = 12f
            val mt = (12 * dp).toInt()
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply { topMargin = mt }
            isClickable = true
            isFocusable = true
            setOnClickListener {
                AlertDialog.Builder(activity)
                    .setTitle("Clear etch history?")
                    .setMessage("This clears the history log only. Private etches are not affected.")
                    .setPositiveButton("Clear") { _, _ ->
                        etchHistory.clear()
                        dialog.dismiss()
                    }
                    .setNegativeButton("Cancel", null)
                    .show()
            }
        }
        root.addView(clearBtn)
    }

    val scroll = NestedScrollView(activity).apply { addView(root) }
    dialog.setContentView(scroll)
    dialog.show()
}

private fun buildHistoryRow(
    activity: Activity,
    entry: EtchHistory.Entry,
    dateFormat: SimpleDateFormat,
    container: LinearLayout,
    dialog: BottomSheetDialog,
    etchHistory: EtchHistory,
    walletSession: WalletSession,
    chainmarkController: ChainmarkController,
    lifecycleScope: CoroutineScope,
    onCopy: (String, String) -> Unit,
    onShowStatus: (String, Boolean) -> Unit,
    onFetchPublic: (String) -> Unit,
    onFetchPrivate: (String) -> Unit,
): LinearLayout {
    val dp = activity.resources.displayMetrics.density
    val row = LinearLayout(activity).apply {
        orientation = LinearLayout.VERTICAL
        val p = (8 * dp).toInt()
        setPadding(p, p, p, p)
        layoutParams = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT,
        ).apply { bottomMargin = (4 * dp).toInt() }
        isClickable = true
        isFocusable = true
    }

    row.addView(TextView(activity).apply {
        val label = entry.title.ifEmpty { "Untitled" }
        text = if (entry.isPrivate) "🔒 $label" else label
        setTextColor(MainActivity.BONE)
        textSize = 13f
        maxLines = 1
        ellipsize = TextUtils.TruncateAt.END
    })

    row.addView(TextView(activity).apply {
        text = if (entry.isPrivate) "Private" else {
            if (entry.address.length > 16) "${entry.address.take(8)}…${entry.address.takeLast(8)}"
            else entry.address
        }
        setTextColor(if (entry.isPrivate) MainActivity.STATUS_GREEN else MainActivity.COPPER)
        textSize = 11f
        typeface = Typeface.MONOSPACE
    })

    row.addView(TextView(activity).apply {
        text = dateFormat.format(Date(entry.timestampMs))
        setTextColor(MainActivity.ASH)
        textSize = 10f
    })

    row.setOnClickListener {
        if (!entry.isPrivate) onCopy(entry.address, "Address")
    }

    row.setOnLongClickListener {
        val session = walletSession.state.value as? SessionState.Connected
        val canAddToChainmarks = !entry.isPrivate &&
            session != null &&
            chainmarkController.isSetUp(session.address)
        val canFetch = if (entry.isPrivate) !entry.dataMapId.isNullOrBlank()
                       else entry.address.length == 64

        val actions = mutableListOf<Pair<String, () -> Unit>>()
        if (canFetch) {
            actions += "Fetch" to {
                // Close the history sheet so the result card is visible.
                dialog.dismiss()
                if (entry.isPrivate) onFetchPrivate(entry.dataMapId!!)
                else onFetchPublic(entry.address)
            }
        }
        if (canAddToChainmarks) {
            actions += "Add to chainmarks" to {
                val s = session!!
                lifecycleScope.launch {
                    try {
                        // History rows are demonstrably the user's own etches → action = add.
                        val txHash = chainmarkController.addByAddress(
                            s.chainId, s.address, entry.address, entry.title, WireEntry.ACTION_ADD,
                        )
                        onShowStatus("Added to chainmarks: ${txHash.take(10)}…", false)
                    } catch (e: Exception) {
                        onShowStatus("Add to chainmarks failed: ${e.message}", true)
                    }
                }
            }
        }
        actions += "Remove from history" to {
            etchHistory.remove(entry)
            container.removeView(row)
            if (container.childCount == 0) dialog.dismiss()
        }

        AlertDialog.Builder(activity)
            .setTitle(entry.title.ifEmpty { "Untitled" })
            .setItems(actions.map { it.first }.toTypedArray()) { _, i -> actions[i].second() }
            .setNegativeButton("Cancel", null)
            .show()
        true
    }

    return row
}
