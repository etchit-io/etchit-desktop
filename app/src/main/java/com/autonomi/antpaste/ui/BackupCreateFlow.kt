package com.autonomi.antpaste.ui

import android.app.Activity
import android.app.AlertDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Typeface
import android.text.InputType
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.widget.addTextChangedListener
import com.autonomi.antpaste.BackupCrypto
import com.autonomi.antpaste.BackupPassphrase
import com.autonomi.antpaste.MainActivity
import com.autonomi.antpaste.PasteUtils
import com.autonomi.antpaste.PrivateDataStore
import com.autonomi.antpaste.vault.BackupPassphraseCache
import com.autonomi.antpaste.wallet.SessionState
import com.autonomi.antpaste.wallet.WalletSession
import com.google.android.material.snackbar.Snackbar

// Dialog stack for "back up my private etches to the network": pick a
// passphrase (or reuse the cached one), confirm cost, hand the encrypted
// blob + passphrase off to the host's etch executor.
//
// `onEtchBackup` is the seam — this class owns the dialogs and the
// passphrase cache reads/writes; the host owns the actual etch lifecycle
// (opHelper, nativeClient, binding visibility, history append).
class BackupCreateFlow(
    private val activity: Activity,
    private val snackbarAnchor: View,
    private val walletSession: WalletSession,
    private val privateDataStore: PrivateDataStore,
    private val passphraseCache: BackupPassphraseCache,
    private val onShowStatus: (msg: String, isError: Boolean) -> Unit,
    private val onEtchBackup: (encrypted: ByteArray, passphrase: String) -> Unit,
) {

    fun start(entryCount: Int) {
        promptBackupPassword(entryCount)
    }

    private fun currentWallet(): String? =
        (walletSession.state.value as? SessionState.Connected)?.address

    private fun promptBackupPassword(entryCount: Int) {
        val wallet = currentWallet()
        if (wallet != null && passphraseCache.has(wallet)) {
            promptEtchBackupWithCachedPassphrase(wallet, entryCount)
            return
        }
        val dp = activity.resources.displayMetrics.density
        val pad = (16 * dp).toInt()
        val layout = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, 0)
        }

        layout.addView(TextView(activity).apply {
            text = "Choose a passphrase. Reuse it across devices, or pick a fresh one each time. " +
                "You'll need it to restore."
            setTextColor(MainActivity.BONE)
        })

        val generateBtn = Button(activity).apply {
            text = "Generate strong passphrase"
            val mt = (12 * dp).toInt()
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply { topMargin = mt }
        }
        layout.addView(generateBtn)

        val passwordInput = EditText(activity).apply {
            hint = "Password (or generated passphrase)"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            setTextColor(MainActivity.BONE)
            val mt = (12 * dp).toInt()
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply { topMargin = mt }
        }
        layout.addView(passwordInput)

        val strengthLabel = TextView(activity).apply {
            textSize = 12f
            val mt = (4 * dp).toInt()
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply { topMargin = mt }
        }
        layout.addView(strengthLabel)
        passwordInput.addTextChangedListener { applyStrength(strengthLabel, it?.toString().orEmpty()) }

        val confirmInput = EditText(activity).apply {
            hint = "Confirm password"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            setTextColor(MainActivity.BONE)
            val mt = (8 * dp).toInt()
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply { topMargin = mt }
        }
        layout.addView(confirmInput)

        // Reveal panel — only added once a passphrase is generated.
        val revealLabel = TextView(activity).apply {
            text = ""
            setTextColor(MainActivity.COPPER_BRIGHT)
            textSize = 12f
            val mt = (12 * dp).toInt()
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply { topMargin = mt }
            visibility = View.GONE
        }
        val revealText = TextView(activity).apply {
            text = ""
            setTextColor(MainActivity.BONE)
            textSize = 14f
            typeface = Typeface.MONOSPACE
            val padIn = (10 * dp).toInt()
            setPadding(padIn, padIn, padIn, padIn)
            setBackgroundColor(0xFF0A0A0A.toInt())
            val mt = (6 * dp).toInt()
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply { topMargin = mt }
            visibility = View.GONE
        }
        val revealHint = TextView(activity).apply {
            text = "Write this down — there is no recovery if lost."
            setTextColor(MainActivity.ASH)
            textSize = 11f
            val mt = (4 * dp).toInt()
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply { topMargin = mt }
            visibility = View.GONE
        }
        layout.addView(revealLabel)
        layout.addView(revealText)
        layout.addView(revealHint)

        generateBtn.setOnClickListener {
            val phrase = BackupPassphrase.generate(6)
            // Drop the password-mask so the user can read what we generated.
            passwordInput.inputType = InputType.TYPE_CLASS_TEXT
            confirmInput.inputType = InputType.TYPE_CLASS_TEXT
            passwordInput.setText(phrase)
            confirmInput.setText(phrase)
            revealLabel.text = "Generated passphrase — write it down before you tap Encrypt"
            revealText.text = phrase
            revealLabel.visibility = View.VISIBLE
            revealText.visibility = View.VISIBLE
            revealHint.visibility = View.VISIBLE
            revealText.setOnClickListener {
                val cm = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                cm.setPrimaryClip(ClipData.newPlainText("etchit backup passphrase", phrase))
                Snackbar.make(snackbarAnchor, "Passphrase copied", Snackbar.LENGTH_SHORT).show()
            }
        }

        AlertDialog.Builder(activity)
            .setTitle("Backup private etches")
            .setView(layout)
            .setPositiveButton("Encrypt") { _, _ ->
                val pw = passwordInput.text.toString()
                val confirm = confirmInput.text.toString()
                if (pw.length < MainActivity.MIN_BACKUP_PASSWORD_LEN) {
                    onShowStatus(
                        "Password must be at least ${MainActivity.MIN_BACKUP_PASSWORD_LEN} characters",
                        true,
                    )
                    return@setPositiveButton
                }
                if (pw != confirm) {
                    onShowStatus("Passwords don't match", true)
                    return@setPositiveButton
                }
                confirmAndEtchBackup(pw, entryCount)
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun applyStrength(label: TextView, pw: String) {
        if (pw.isEmpty()) { label.text = ""; return }
        val classes = listOf(
            pw.any { it.isLowerCase() },
            pw.any { it.isUpperCase() },
            pw.any { it.isDigit() },
            pw.any { !it.isLetterOrDigit() },
        ).count { it }
        val (text, color) = when {
            pw.length < MainActivity.MIN_BACKUP_PASSWORD_LEN ->
                "Weak — use at least ${MainActivity.MIN_BACKUP_PASSWORD_LEN} characters" to MainActivity.STATUS_RED
            pw.length >= 12 || classes >= 3 -> "Strong" to MainActivity.STATUS_GREEN
            else -> "OK — stronger with mixed character types" to MainActivity.COPPER_BRIGHT
        }
        label.text = text
        label.setTextColor(color)
    }

    private fun confirmAndEtchBackup(password: String, entryCount: Int) {
        val plaintext = privateDataStore.exportAll()
        val encrypted = BackupCrypto.encrypt(plaintext, password)
        val sizeStr = PasteUtils.formatSize(encrypted.size)

        AlertDialog.Builder(activity)
            .setTitle("Backup ready")
            .setMessage(
                "$sizeStr encrypted • $entryCount private etch${if (entryCount > 1) "es" else ""}\n\n" +
                "Etch this backup to the network? It will cost a small amount of ANT. " +
                "Anyone can fetch it but only your password can decrypt it."
            )
            .setPositiveButton("Etch backup") { _, _ ->
                onEtchBackup(encrypted, password)
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    // Pre-flight dialog when the wallet already has a cached backup passphrase.
    // Skips the password entry form and goes straight to encrypt + etch using
    // the cached value. Inline links offer "show" and "use a different one"
    // for the rare cases where the user wants to verify or rotate.
    private fun promptEtchBackupWithCachedPassphrase(wallet: String, entryCount: Int) {
        val cached = passphraseCache.load(wallet)
        if (cached == null) {
            // Cache lookup failed — fall back to normal flow.
            passphraseCache.clear(wallet)
            promptBackupPassword(entryCount)
            return
        }
        val dp = activity.resources.displayMetrics.density
        val pad = (16 * dp).toInt()
        val layout = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, 0)
        }
        layout.addView(TextView(activity).apply {
            text = "Recovery passphrase set for this wallet. New backup will encrypt with the same passphrase you wrote down — no entry needed.\n\n" +
                "$entryCount private etch${if (entryCount > 1) "es" else ""} will be encrypted and etched to the network."
            setTextColor(MainActivity.BONE)
        })
        val linksRow = LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            val mt = (16 * dp).toInt()
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply { topMargin = mt }
        }
        val showLink = TextView(activity).apply {
            text = "Show passphrase"
            setTextColor(MainActivity.COPPER_BRIGHT)
            textSize = 13f
            paint.isUnderlineText = true
            val mr = (24 * dp).toInt()
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply { rightMargin = mr }
        }
        val differentLink = TextView(activity).apply {
            text = "Use a different one"
            setTextColor(MainActivity.COPPER_BRIGHT)
            textSize = 13f
            paint.isUnderlineText = true
        }
        linksRow.addView(showLink)
        linksRow.addView(differentLink)
        layout.addView(linksRow)

        val dialog = AlertDialog.Builder(activity)
            .setTitle("Back up private etches")
            .setView(layout)
            .setPositiveButton("Etch backup") { _, _ ->
                confirmAndEtchBackup(cached, entryCount)
            }
            .setNegativeButton("Cancel", null)
            .create()

        showLink.setOnClickListener {
            dialog.dismiss()
            showCachedPassphraseDialog(cached) {
                promptEtchBackupWithCachedPassphrase(wallet, entryCount)
            }
        }
        differentLink.setOnClickListener {
            dialog.dismiss()
            promptUseDifferentPassphrase(wallet, entryCount)
        }
        dialog.show()
    }

    private fun promptUseDifferentPassphrase(wallet: String, entryCount: Int) {
        AlertDialog.Builder(activity)
            .setTitle("Use a different passphrase?")
            .setMessage(
                "Your current cached passphrase will be removed from this device. " +
                "Existing backups encrypted with the old passphrase still decrypt with it (you'd need to remember both for those), " +
                "and your next new backup will use whatever passphrase you pick now."
            )
            .setPositiveButton("Use a different one") { _, _ ->
                passphraseCache.clear(wallet)
                promptBackupPassword(entryCount)
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun showCachedPassphraseDialog(passphrase: String, onDismiss: () -> Unit) {
        val dp = activity.resources.displayMetrics.density
        val pad = (16 * dp).toInt()
        val layout = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, 0)
        }
        layout.addView(TextView(activity).apply {
            text = "Your recovery passphrase. Tap to copy. Anyone with this can decrypt your backup blobs."
            setTextColor(MainActivity.BONE)
            textSize = 13f
        })
        val phraseView = TextView(activity).apply {
            text = passphrase
            setTextColor(MainActivity.BONE)
            typeface = Typeface.MONOSPACE
            textSize = 14f
            val padIn = (10 * dp).toInt()
            setPadding(padIn, padIn, padIn, padIn)
            setBackgroundColor(0xFF0A0A0A.toInt())
            val mt = (16 * dp).toInt()
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply { topMargin = mt }
        }
        phraseView.setOnClickListener {
            val cm = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            cm.setPrimaryClip(ClipData.newPlainText("etchit backup passphrase", passphrase))
            Snackbar.make(snackbarAnchor, "Passphrase copied", Snackbar.LENGTH_SHORT).show()
        }
        layout.addView(phraseView)
        AlertDialog.Builder(activity)
            .setTitle("Recovery passphrase")
            .setView(layout)
            .setPositiveButton("Done") { _, _ -> onDismiss() }
            .setOnCancelListener { onDismiss() }
            .show()
    }
}
