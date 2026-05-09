package com.autonomi.antpaste.ui

import android.app.AlertDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Typeface
import android.text.InputType
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.core.widget.NestedScrollView
import androidx.fragment.app.FragmentActivity
import com.autonomi.antpaste.EtchHistory
import com.autonomi.antpaste.MainActivity
import com.autonomi.antpaste.R
import com.autonomi.antpaste.chainmark.ChainmarkController
import com.autonomi.antpaste.chainmark.ChainmarkEntry
import com.autonomi.antpaste.chainmark.WireEntry
import com.autonomi.antpaste.wallet.SessionState
import com.autonomi.antpaste.wallet.WalletSession
import com.google.android.material.bottomsheet.BottomSheetDialog
import com.google.android.material.button.MaterialButton
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

// "chain/it" — the encrypted on-chain index of public etches.
//
// Single bottom-sheet entry point (`show()`); every other dialog in this file
// (entry rows, bulk-add flows, key backup/restore) is reached from there.
// Constructed once with the host's deps and reused for every open.
class ChainmarkScreen(
    private val activity: FragmentActivity,
    private val walletSession: WalletSession,
    private val chainmarkController: ChainmarkController,
    private val etchHistory: EtchHistory,
    private val lifecycleScope: CoroutineScope,
    private val onShowStatus: (msg: String, isError: Boolean) -> Unit,
) {

    fun show() {
        val dialog = BottomSheetDialog(activity, R.style.SheetDialog)
        val dp = activity.resources.displayMetrics.density
        val pad = (24 * dp).toInt()

        val container = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
            setBackgroundColor(MainActivity.INK)
        }

        fun heading(text: String, sizeSp: Float = 20f, bottomMarginDp: Int = 4) = TextView(activity).apply {
            this.text = text
            setTextColor(MainActivity.BONE)
            textSize = sizeSp
            setTypeface(typeface, Typeface.BOLD)
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply { bottomMargin = (bottomMarginDp * dp).toInt() }
        }

        fun muted(text: String, bottomMarginDp: Int = 16) = TextView(activity).apply {
            this.text = text
            setTextColor(MainActivity.ASH)
            textSize = 12f
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply { bottomMargin = (bottomMarginDp * dp).toInt() }
        }

        fun primaryButton(text: String, topMarginDp: Int = 8, onClick: () -> Unit) =
            MaterialButton(activity).apply {
                this.text = text
                textSize = 13f
                isAllCaps = false
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                ).apply { topMargin = (topMarginDp * dp).toInt() }
                setOnClickListener { onClick() }
            }

        fun outlinedButton(text: String, topMarginDp: Int = 8, onClick: () -> Unit) =
            MaterialButton(
                activity,
                null,
                com.google.android.material.R.attr.materialButtonOutlinedStyle,
            ).apply {
                this.text = text
                textSize = 13f
                isAllCaps = false
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                ).apply { topMargin = (topMarginDp * dp).toInt() }
                setOnClickListener { onClick() }
            }

        lateinit var render: () -> Unit
        render = {
            container.removeAllViews()
            container.addView(heading("chain/it"))
            container.addView(muted(
                "An encrypted on-chain index of your public etches. Off until you set it up. " +
                "Each sync writes one Arbitrum transaction — your wallet shows the gas estimate before you sign. See README for the full privacy model."
            ))

            val session = walletSession.state.value
            when {
                session !is SessionState.Connected -> {
                    container.addView(muted("Connect a wallet first to use chain/it.", bottomMarginDp = 0))
                }
                !chainmarkController.isSetUp(session.address) -> {
                    container.addView(muted(
                        "Setting up requires one signature to derive your chainmark encryption key. " +
                        "This signature does NOT authorize any transaction.", bottomMarginDp = 8))
                    container.addView(primaryButton("Set up chain/it") {
                        lifecycleScope.launch {
                            try {
                                chainmarkController.setUp(session.chainId, session.address)
                                onShowStatus("chain/it set up.", false)
                                render()
                            } catch (e: Exception) {
                                onShowStatus("Setup failed: ${e.message}", true)
                            }
                        }
                    })
                }
                else -> {
                    val wallet = session.address
                    val chainId = session.chainId

                    val visible = chainmarkController.entriesFor(wallet).values
                        .filterNot { it.isHidden }
                        .sortedByDescending { it.ts }

                    if (visible.isEmpty()) {
                        container.addView(muted(
                            "No entries loaded. Tap Sync chainmarks to fetch from chain, or Add by address to add one.",
                            bottomMarginDp = 8))
                    } else {
                        container.addView(muted("${visible.size} entr${if (visible.size == 1) "y" else "ies"}", bottomMarginDp = 8))
                        val list = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }
                        val df = SimpleDateFormat("MMM d, yyyy", Locale.getDefault())
                        for (e in visible) {
                            list.addView(chainmarkEntryRow(e, df, dialog) { render() })
                        }
                        container.addView(list)
                    }

                    container.addView(primaryButton("Sync chainmarks", topMarginDp = 16) {
                        lifecycleScope.launch {
                            try {
                                onShowStatus("Syncing chainmarks…", false)
                                chainmarkController.restoreFromChain(wallet)
                                onShowStatus("Chainmarks synced.", false)
                                render()
                            } catch (e: Exception) {
                                onShowStatus("Sync failed: ${e.message}", true)
                            }
                        }
                    })

                    container.addView(outlinedButton("Add by address") {
                        promptAddByAddress { addr, title ->
                            lifecycleScope.launch {
                                try {
                                    val txHash = chainmarkController.addByAddress(chainId, wallet, addr, title, WireEntry.ACTION_ADD)
                                    onShowStatus("Synced: ${txHash.take(10)}…", false)
                                    render()
                                } catch (e: Exception) {
                                    onShowStatus("Add failed: ${e.message}", true)
                                }
                            }
                        }
                    })

                    container.addView(outlinedButton("Add multiple from history") {
                        bulkAddFromHistoryDialog(chainId, wallet) { render() }
                    })

                    container.addView(outlinedButton("Add multiple by address") {
                        bulkAddByAddressDialog(chainId, wallet) { render() }
                    })

                    container.addView(outlinedButton("Back up chainmark key") {
                        backupChainmarkKeyWithBiometric(wallet)
                    })

                    container.addView(outlinedButton("Restore chainmark key from backup") {
                        promptRestoreChainmarkKey(wallet) { render() }
                    })

                    container.addView(outlinedButton("Forget chain/it on this device") {
                        AlertDialog.Builder(activity)
                            .setTitle("Forget chain/it?")
                            .setMessage(
                                "Removes the chainmark key from this device. Your on-chain entries remain " +
                                "permanent and you can restore by setting up again with the same wallet, " +
                                "or by pasting in a backup of the key."
                            )
                            .setPositiveButton("Forget") { _, _ ->
                                chainmarkController.forget(wallet)
                                onShowStatus("chain/it forgotten on this device.", false)
                                render()
                            }
                            .setNegativeButton("Cancel", null)
                            .show()
                    })
                }
            }
        }

        render()

        val scroll = NestedScrollView(activity).apply { addView(container) }
        dialog.setContentView(scroll)
        dialog.show()
    }

    private fun chainmarkEntryRow(
        entry: ChainmarkEntry,
        dateFormat: SimpleDateFormat,
        dialog: BottomSheetDialog,
        onChanged: () -> Unit,
    ): View {
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
        val titleLine = entry.title.ifEmpty { "Untitled" }
        row.addView(TextView(activity).apply {
            text = titleLine
            setTextColor(MainActivity.BONE)
            textSize = 13f
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
        })
        row.addView(TextView(activity).apply {
            text = "${entry.addr.take(10)}…  ${if (entry.ts > 0) dateFormat.format(Date(entry.ts * 1000)) else ""}"
            setTextColor(MainActivity.ASH)
            textSize = 10f
        })

        row.setOnClickListener {
            val cm = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            cm.setPrimaryClip(ClipData.newPlainText("etch address", entry.addr))
            onShowStatus("Address copied", false)
        }

        row.setOnLongClickListener {
            val session = walletSession.state.value as? SessionState.Connected ?: return@setOnLongClickListener true
            AlertDialog.Builder(activity)
                .setTitle("Hide from chain/it?")
                .setMessage(
                    "Writes a permanent tombstone to your on-chain chainmarks. The etch itself stays " +
                    "on the network. Costs one wallet transaction."
                )
                .setPositiveButton("Hide") { _, _ ->
                    lifecycleScope.launch {
                        try {
                            chainmarkController.hide(session.chainId, session.address, entry.addr)
                            (row.parent as? LinearLayout)?.removeView(row)
                            onShowStatus("Hide queued.", false)
                            onChanged()
                        } catch (e: Exception) {
                            onShowStatus("Hide failed: ${e.message}", true)
                        }
                    }
                }
                .setNegativeButton("Cancel", null)
                .show()
            true
        }
        return row
    }

    // Biometric (or device-credential) gate before revealing the key. Falls
    // through to the plain reveal dialog when no auth is enrolled — there's
    // nothing to gate against.
    private fun backupChainmarkKeyWithBiometric(walletAddress: String) {
        val authenticators = BiometricManager.Authenticators.BIOMETRIC_WEAK or
            BiometricManager.Authenticators.DEVICE_CREDENTIAL
        val canAuth = BiometricManager.from(activity).canAuthenticate(authenticators)
        if (canAuth != BiometricManager.BIOMETRIC_SUCCESS) {
            showChainmarkKeyBackup(walletAddress)
            return
        }
        val executor = ContextCompat.getMainExecutor(activity)
        val prompt = BiometricPrompt(activity, executor, object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                showChainmarkKeyBackup(walletAddress)
            }
            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                if (errorCode != BiometricPrompt.ERROR_USER_CANCELED &&
                    errorCode != BiometricPrompt.ERROR_NEGATIVE_BUTTON) {
                    onShowStatus("Authentication failed: $errString", true)
                }
            }
        })
        prompt.authenticate(BiometricPrompt.PromptInfo.Builder()
            .setTitle("Back up chainmark key")
            .setDescription("Authenticate to reveal the 32-byte key")
            .setAllowedAuthenticators(authenticators)
            .build())
    }

    private fun showChainmarkKeyBackup(walletAddress: String) {
        val key = chainmarkController.exportKey(walletAddress)
        if (key == null) {
            onShowStatus("No chainmark key to back up", true)
            return
        }
        val hex = key.joinToString("") { "%02x".format(it.toInt() and 0xff) }
        val dp = activity.resources.displayMetrics.density
        val pad = (16 * dp).toInt()
        val layout = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
        }
        layout.addView(TextView(activity).apply {
            text = "Save this in a password manager. Anyone with it can decrypt your chainmark entries on chain. The key is bound to this wallet only."
            setTextColor(MainActivity.ASH)
            textSize = 12f
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply { bottomMargin = (12 * dp).toInt() }
        })
        layout.addView(TextView(activity).apply {
            text = hex
            setTextColor(MainActivity.BONE)
            textSize = 12f
            typeface = Typeface.MONOSPACE
            setTextIsSelectable(true)
        })
        AlertDialog.Builder(activity)
            .setTitle("Chainmark key (hex)")
            .setView(layout)
            .setPositiveButton("Copy") { _, _ ->
                val cm = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                cm.setPrimaryClip(ClipData.newPlainText("chainmark key", hex))
                onShowStatus("Chainmark key copied", false)
            }
            .setNegativeButton("Close", null)
            .show()
    }

    private fun promptRestoreChainmarkKey(walletAddress: String, onDone: () -> Unit) {
        val dp = activity.resources.displayMetrics.density
        val pad = (16 * dp).toInt()
        val layout = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
        }
        layout.addView(TextView(activity).apply {
            text = "Paste the 64-character hex key from a previous backup. Replaces the current device's key."
            setTextColor(MainActivity.ASH)
            textSize = 12f
        })
        val input = EditText(activity).apply {
            hint = "64-char hex"
            setSingleLine(true)
        }
        layout.addView(input)
        AlertDialog.Builder(activity)
            .setTitle("Restore chainmark key")
            .setView(layout)
            .setPositiveButton("Restore") { _, _ ->
                val raw = input.text.toString().trim().removePrefix("0x")
                val bytes = try {
                    require(raw.length == 64) { "expected 64 hex chars, got ${raw.length}" }
                    ByteArray(32) { i ->
                        ((Character.digit(raw[i * 2], 16) shl 4) + Character.digit(raw[i * 2 + 1], 16)).toByte()
                    }
                } catch (e: Exception) {
                    onShowStatus("Invalid key: ${e.message}", true)
                    return@setPositiveButton
                }
                try {
                    chainmarkController.importKey(walletAddress, bytes)
                    onShowStatus("Chainmark key restored. Tap Sync chainmarks.", false)
                    onDone()
                } catch (e: Exception) {
                    onShowStatus("Restore failed: ${e.message}", true)
                }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun bulkAddFromHistoryDialog(
        chainId: String,
        walletAddress: String,
        onDone: () -> Unit,
    ) {
        val historyEntries = etchHistory.load().filter { !it.isPrivate && it.address.isNotBlank() }
        if (historyEntries.isEmpty()) {
            onShowStatus("No public etches in history.", true)
            return
        }

        val dialog = BottomSheetDialog(activity, R.style.SheetDialog)
        val dp = activity.resources.displayMetrics.density
        val pad = (24 * dp).toInt()

        val root = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
            setBackgroundColor(MainActivity.INK)
        }

        root.addView(TextView(activity).apply {
            text = "Add multiple from history"
            setTextColor(MainActivity.BONE)
            textSize = 20f
            setTypeface(typeface, Typeface.BOLD)
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply { bottomMargin = (4 * dp).toInt() }
        })
        root.addView(TextView(activity).apply {
            text = "Tick the public etches to add. ~130 small entries fit in one batch tx; bigger lists split into multiple wallet prompts."
            setTextColor(MainActivity.ASH)
            textSize = 12f
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply { bottomMargin = (12 * dp).toInt() }
        })

        val countText = TextView(activity).apply {
            text = "0 selected"
            setTextColor(MainActivity.ASH)
            textSize = 12f
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply { bottomMargin = (8 * dp).toInt() }
        }
        root.addView(countText)

        val checkboxes = mutableListOf<CheckBox>()
        for (entry in historyEntries) {
            val cb = CheckBox(activity).apply {
                text = "${entry.title.ifEmpty { "Untitled" }}\n${entry.address.take(10)}…"
                setTextColor(MainActivity.BONE)
                isChecked = false
            }
            checkboxes += cb
            root.addView(cb)
        }

        val actionRow = LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply { topMargin = (16 * dp).toInt() }
        }
        val cancelBtn = MaterialButton(
            activity, null, com.google.android.material.R.attr.materialButtonOutlinedStyle,
        ).apply {
            text = "Cancel"
            isAllCaps = false
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply {
                marginEnd = (8 * dp).toInt()
            }
            setOnClickListener { dialog.dismiss() }
        }
        val addBtn = MaterialButton(activity).apply {
            text = "Add 0"
            isAllCaps = false
            isEnabled = false
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }
        actionRow.addView(cancelBtn)
        actionRow.addView(addBtn)
        root.addView(actionRow)

        fun refreshCount() {
            val n = checkboxes.count { it.isChecked }
            countText.text = "$n selected"
            addBtn.text = if (n == 0) "Add" else "Add $n"
            addBtn.isEnabled = n > 0
        }
        for (cb in checkboxes) cb.setOnCheckedChangeListener { _, _ -> refreshCount() }

        addBtn.setOnClickListener {
            val selected = checkboxes.zip(historyEntries)
                .filter { (cb, _) -> cb.isChecked }
                .map { (_, entry) -> entry.address to entry.title }
            if (selected.isEmpty()) return@setOnClickListener
            dialog.dismiss()
            lifecycleScope.launch {
                try {
                    onShowStatus("Sending ${selected.size} entries…", false)
                    val txHashes = chainmarkController.addMultiple(chainId, walletAddress, selected, WireEntry.ACTION_ADD)
                    val plural = if (txHashes.size > 1) "${txHashes.size} txs" else "1 tx"
                    onShowStatus("Synced ${selected.size} entries in $plural", false)
                    onDone()
                } catch (e: Exception) {
                    onShowStatus("Bulk add failed: ${e.message}", true)
                }
            }
        }

        val scroll = NestedScrollView(activity).apply { addView(root) }
        dialog.setContentView(scroll)
        dialog.show()
    }

    private fun bulkAddByAddressDialog(
        chainId: String,
        walletAddress: String,
        onDone: () -> Unit,
    ) {
        val dp = activity.resources.displayMetrics.density
        val pad = (16 * dp).toInt()
        val layout = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
        }
        layout.addView(TextView(activity).apply {
            text = "Paste 64-char etch addresses, one per line. Optional: add a space and a title after each address."
            setTextColor(MainActivity.ASH)
            textSize = 12f
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply { bottomMargin = (8 * dp).toInt() }
        })
        val input = EditText(activity).apply {
            hint = "abcdef…  optional title\n0x1234…  another title\n…"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE
            setSingleLine(false)
            minLines = 6
            gravity = Gravity.TOP or Gravity.START
        }
        layout.addView(input)

        AlertDialog.Builder(activity)
            .setTitle("Add multiple by address")
            .setView(layout)
            .setPositiveButton("Add") { _, _ ->
                val (entries, badLines) = parseAddressList(input.text.toString())
                if (entries.isEmpty()) {
                    onShowStatus("No valid addresses found", true)
                    return@setPositiveButton
                }
                lifecycleScope.launch {
                    try {
                        onShowStatus("Adding ${entries.size}…", false)
                        val txHashes = chainmarkController.addMultiple(
                            chainId, walletAddress, entries, WireEntry.ACTION_ADD,
                        )
                        val plural = if (txHashes.size > 1) "${txHashes.size} txs" else "1 tx"
                        val skip = if (badLines.isNotEmpty()) " (skipped ${badLines.size} invalid line${if (badLines.size > 1) "s" else ""})" else ""
                        onShowStatus("Added ${entries.size} in $plural$skip", false)
                        onDone()
                    } catch (e: Exception) {
                        onShowStatus("Bulk add failed: ${e.message}", true)
                    }
                }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun promptAddByAddress(onSubmit: (String, String) -> Unit) {
        val dp = activity.resources.displayMetrics.density
        val pad = (16 * dp).toInt()
        val layout = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
        }
        val addrInput = EditText(activity).apply {
            hint = "64-character hex address"
            setSingleLine(true)
        }
        val titleInput = EditText(activity).apply {
            hint = "Title (optional)"
            setSingleLine(true)
        }
        layout.addView(addrInput)
        layout.addView(titleInput)
        AlertDialog.Builder(activity)
            .setTitle("Add to chainmarks")
            .setView(layout)
            .setPositiveButton("Add") { _, _ ->
                onSubmit(
                    addrInput.text.toString().trim(),
                    titleInput.text.toString().trim(),
                )
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    // Each non-empty line: 64-char hex address; everything after the first
    // whitespace is the optional title. Returns (validEntries, badLineNumbers).
    private fun parseAddressList(input: String): Pair<List<Pair<String, String>>, List<Int>> {
        val out = mutableListOf<Pair<String, String>>()
        val bad = mutableListOf<Int>()
        input.split("\n").forEachIndexed { i, raw ->
            val line = raw.trim()
            if (line.isEmpty()) return@forEachIndexed
            val parts = line.split(Regex("\\s+"), limit = 2)
            val addr = parts[0].lowercase().removePrefix("0x")
            val title = if (parts.size > 1) parts[1].trim() else ""
            if (addr.length == 64 && addr.all { it in '0'..'9' || it in 'a'..'f' }) {
                out += addr to title
            } else {
                bad += i + 1
            }
        }
        return out to bad
    }
}
