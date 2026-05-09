package com.autonomi.antpaste.ui

import android.app.Activity
import android.app.AlertDialog
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import com.autonomi.antpaste.BackupCrypto
import com.autonomi.antpaste.MainActivity
import com.autonomi.antpaste.PrivateDataStore
import com.google.android.material.snackbar.Snackbar

// "Restore backup" passphrase prompt — shown when fetched bytes are
// detected as an encrypted etchit backup blob. Renders a 3×2 grid of
// word boxes (with paste-the-whole-phrase support) plus a custom-
// password fallback toggle. On confirm, decrypts via BackupCrypto and
// merges into the host's PrivateDataStore.
fun promptRestoreBackup(
    activity: Activity,
    snackbarAnchor: View,
    encryptedData: ByteArray,
    privateDataStore: PrivateDataStore,
    onShowStatus: (msg: String, isError: Boolean) -> Unit,
    currentWalletAddress: () -> String?,
    savePassphrase: (wallet: String, pw: String) -> Unit,
) {
    val dp = activity.resources.displayMetrics.density
    val pad = (20 * dp).toInt()
    val layout = LinearLayout(activity).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(pad, pad, pad, 0)
    }

    layout.addView(TextView(activity).apply {
        text = "This is an encrypted etchit backup. Enter the 6-word recovery passphrase to restore your private etches."
        setTextColor(MainActivity.BONE)
    })

    // 3×2 grid of word boxes
    val gridWrap = LinearLayout(activity).apply {
        orientation = LinearLayout.VERTICAL
        layoutParams = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT,
        ).apply { topMargin = (20 * dp).toInt() }
    }
    layout.addView(gridWrap)

    val boxes = mutableListOf<EditText>()
    repeat(2) { rowIdx ->
        val row = LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply { if (rowIdx > 0) topMargin = (10 * dp).toInt() }
        }
        repeat(3) { colIdx ->
            val idx = rowIdx * 3 + colIdx
            if (colIdx > 0) {
                row.addView(TextView(activity).apply {
                    text = "—"
                    setTextColor(MainActivity.ASH)
                    textSize = 14f
                    val mh = (6 * dp).toInt()
                    setPadding(mh, 0, mh, 0)
                })
            }
            val box = EditText(activity).apply {
                hint = "${idx + 1}"
                setTextColor(MainActivity.BONE)
                setHintTextColor(MainActivity.ASH)
                textSize = 14f
                typeface = android.graphics.Typeface.MONOSPACE
                setPadding((10 * dp).toInt(), (10 * dp).toInt(), (10 * dp).toInt(), (10 * dp).toInt())
                inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
                isSingleLine = true
                imeOptions = if (idx == 5) EditorInfo.IME_ACTION_DONE
                             else EditorInfo.IME_ACTION_NEXT
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
            }
            row.addView(box)
            boxes += box
        }
        gridWrap.addView(row)
    }

    // Auto-advance on space/dash; backspace on empty → previous;
    // paste of full dashed phrase distributes across all boxes.
    for ((idx, box) in boxes.withIndex()) {
        box.addTextChangedListener(object : TextWatcher {
            private var skip = false
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(s: Editable?) {
                if (skip || s == null) return
                val text = s.toString()
                if (text.contains('-') || text.contains(' ') || text.contains('\n')) {
                    val parts = text.split(Regex("[\\s\\-—]+")).filter { it.isNotEmpty() }
                    if (parts.size >= 2 || (parts.size == 1 && (text.endsWith(' ') || text.endsWith('-')))) {
                        skip = true
                        for ((i, p) in parts.withIndex()) {
                            val target = idx + i
                            if (target < boxes.size) {
                                boxes[target].setText(p.lowercase())
                            }
                        }
                        val nextEmpty = (idx + parts.size).coerceAtMost(boxes.size - 1)
                        boxes[nextEmpty].requestFocus()
                        boxes[nextEmpty].setSelection(boxes[nextEmpty].text.length)
                        skip = false
                        return
                    }
                    skip = true
                    s.replace(0, s.length, parts.firstOrNull().orEmpty().lowercase())
                    skip = false
                    if (idx < boxes.size - 1) boxes[idx + 1].requestFocus()
                }
            }
        })
        box.setOnKeyListener { _, keyCode, event ->
            if (event.action == KeyEvent.ACTION_DOWN &&
                keyCode == KeyEvent.KEYCODE_DEL &&
                box.text.isEmpty() && idx > 0) {
                boxes[idx - 1].requestFocus()
                boxes[idx - 1].setSelection(boxes[idx - 1].text.length)
                return@setOnKeyListener true
            }
            false
        }
    }

    // Custom-password fallback — hidden by default.
    val customInput = EditText(activity).apply {
        hint = "Custom password"
        inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        setTextColor(MainActivity.BONE)
        setHintTextColor(MainActivity.ASH)
        visibility = View.GONE
        layoutParams = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT,
        ).apply { topMargin = (20 * dp).toInt() }
    }
    layout.addView(customInput)

    var customMode = false
    val toggleLink = TextView(activity).apply {
        text = "Use a custom password instead"
        setTextColor(MainActivity.COPPER)
        textSize = 13f
        paint.isUnderlineText = true
        val mt = (16 * dp).toInt()
        val mb = (4 * dp).toInt()
        setPadding(0, mt, 0, mb)
        setOnClickListener {
            customMode = !customMode
            if (customMode) {
                gridWrap.visibility = View.GONE
                customInput.visibility = View.VISIBLE
                customInput.requestFocus()
                text = "Use the 6-word passphrase instead"
            } else {
                gridWrap.visibility = View.VISIBLE
                customInput.visibility = View.GONE
                boxes[0].requestFocus()
                text = "Use a custom password instead"
            }
        }
    }
    layout.addView(toggleLink)

    boxes[0].requestFocus()

    AlertDialog.Builder(activity)
        .setTitle("Restore backup")
        .setView(layout)
        .setPositiveButton("Restore") { _, _ ->
            val pw = if (customMode) customInput.text.toString()
                     else boxes.joinToString("-") { it.text.toString().trim().lowercase() }
            val decrypted = BackupCrypto.decrypt(encryptedData, pw)
            if (decrypted == null) {
                onShowStatus("Wrong password or corrupted backup", true)
                return@setPositiveButton
            }
            val imported = privateDataStore.importAll(decrypted)
            if (imported > 0) {
                val msg = "Restored $imported private etch${if (imported > 1) "es" else ""}"
                onShowStatus(msg, false)
                Snackbar.make(snackbarAnchor, msg, Snackbar.LENGTH_LONG)
                    .setBackgroundTint(MainActivity.INK_3)
                    .setTextColor(MainActivity.STATUS_GREEN)
                    .show()
            } else {
                onShowStatus("All etches already on this device", false)
            }
            // Cache the restore passphrase under this wallet so future
            // backups on this device automatically reuse it. Symmetric with
            // the backup-side caching — saves a second passphrase entry on
            // a fresh device.
            currentWalletAddress()?.let { savePassphrase(it, pw) }
        }
        .setNegativeButton("Cancel", null)
        .show()
}
