package com.autonomi.antpaste

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.util.Log
import android.view.View
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.autonomi.antpaste.databinding.ActivityBlogComposeBinding
import com.autonomi.antpaste.ui.QrShare
import com.autonomi.antpaste.vault.EtchSigner
import com.autonomi.antpaste.wallet.EvmRpc
import com.autonomi.antpaste.wallet.SessionState
import com.google.android.material.snackbar.Snackbar
import kotlin.coroutines.resume
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import java.math.BigDecimal
import java.math.BigInteger
import java.math.RoundingMode

/**
 * Two-state activity: write a post, publish it, get a QR.
 *
 * Compose state is two boxes (title, body) + a Publish button. On publish
 * the title+body are wrapped in a brand-styled self-contained HTML page
 * (see [BlogHtml]) and pushed through the same EtchSigner flow MainActivity
 * uses — collect quotes, optional ANT approval, payForQuotes, finalize.
 *
 * Result state shows the permanent 64-hex address, an inline QR card
 * (rendered by [QrShare.renderCardFor]), and Share / Copy / View
 * buttons. Share fires the system share sheet with the PNG card and a
 * fallback text body.
 *
 * Process-shared state (FFI client, wallet session, walletSigner) is
 * read from [EtchitApplication]; this activity does **not** establish
 * its own connection. If the FFI client isn't up yet, publishing shows
 * a friendly status and bails — the user pulls up MainActivity once to
 * let it connect, then returns.
 */
class BlogComposeActivity : AppCompatActivity() {

    private lateinit var binding: ActivityBlogComposeBinding
    private val app: EtchitApplication get() = application as EtchitApplication
    private val walletSession by lazy { app.walletSession }
    private val walletSigner by lazy { app.walletSigner }
    private lateinit var opHelper: OperationHelper
    private lateinit var etchHistory: EtchHistory

    private var publishJob: Job? = null
    private var publishedAddress: String? = null
    private var publishedTitle: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityBlogComposeBinding.inflate(layoutInflater)
        setContentView(binding.root)

        val prefs = getSharedPreferences("ant_paste", Context.MODE_PRIVATE)
        etchHistory = EtchHistory(prefs)
        opHelper = OperationHelper(this)

        binding.composeBackBtn.setOnClickListener { onBackPressedDispatcher.onBackPressed() }

        // Publish is only enabled once there's a non-empty title.
        binding.blogTitleInput.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(s: Editable?) {
                binding.blogPublishBtn.isEnabled = !s.isNullOrBlank()
            }
        })

        binding.blogPublishBtn.setOnClickListener { onPublishClicked() }

        // Result-state buttons
        binding.resultShareBtn.setOnClickListener { shareCurrentQr() }
        binding.resultCopyBtn.setOnClickListener { copyAddressToClipboard() }
        binding.resultViewBtn.setOnClickListener { openInExternalViewer() }
        binding.resultNewBtn.setOnClickListener { resetToCompose() }
        binding.resultDoneBtn.setOnClickListener { finish() }
    }

    override fun onDestroy() {
        publishJob?.cancel()
        super.onDestroy()
    }

    // ─── publish flow ─────────────────────────────────────────────

    private fun onPublishClicked() {
        val title = binding.blogTitleInput.text.toString().trim()
        if (title.isEmpty()) return
        val body = binding.blogBodyInput.text.toString()

        // Preconditions: wallet connected + FFI client up.
        if (walletSession.state.value !is SessionState.Connected) {
            showSnackbar("Connect a wallet first — open the main screen and tap Connect.")
            return
        }
        val nativeClient = app.nativeClient
        if (nativeClient == null) {
            showSnackbar("Network not connected yet — open the main screen so it can connect, then come back.")
            return
        }

        val html = BlogHtml.render(title, body)
        val htmlBytes = html.toByteArray(Charsets.UTF_8)
        Log.i("ant-paste", "Blog: publishing post '${title.take(40)}' (${htmlBytes.size} bytes)")

        setComposingLocked(true)
        setStatus("Preparing…")

        publishJob = lifecycleScope.launch {
            opHelper.start("Publishing blog post…")
            try {
                val signer = EtchSigner(
                    nativeClient = nativeClient,
                    walletSession = walletSession,
                    walletSigner = walletSigner,
                    evmRpc = EvmRpc(BuildConfig.RPC_URL),
                )

                val result = withContext(Dispatchers.IO) {
                    signer.etch(
                        data = htmlBytes,
                        private = false,
                        costPrompt = { totalAtto, dataSize, needsApproval ->
                            withContext(Dispatchers.Main) {
                                promptCostConfirm(totalAtto, dataSize, needsApproval)
                            }
                        },
                        onProgress = { phase ->
                            val text = describeProgress(phase)
                            lifecycleScope.launch(Dispatchers.Main) {
                                setStatus(text)
                                opHelper.updateProgress(this@BlogComposeActivity, text)
                            }
                            if (phase is EtchSigner.Progress.ApprovingToken ||
                                phase is EtchSigner.Progress.SigningPayment
                            ) {
                                opHelper.notifyApprovalNeeded()
                            }
                        },
                    )
                }

                if (result == null) {
                    setStatus("Cancelled")
                    setComposingLocked(false)
                    return@launch
                }

                val address = (result as? EtchSigner.EtchResult.Public)?.address
                if (address == null) {
                    setStatus("Publish failed: unexpected private result")
                    setComposingLocked(false)
                    return@launch
                }

                etchHistory.add(address, title)
                showResult(address, title)
            } catch (e: CancellationException) {
                setStatus("Cancelled")
                setComposingLocked(false)
                throw e
            } catch (e: Exception) {
                Log.e("ant-paste", "blog publish failed (${e.javaClass.simpleName}): ${e.message}", e)
                setStatus("Failed: ${e.message ?: e.javaClass.simpleName}")
                setComposingLocked(false)
            } finally {
                opHelper.finish()
            }
        }
    }

    private fun setComposingLocked(locked: Boolean) {
        binding.blogTitleInput.isEnabled = !locked
        binding.blogBodyInput.isEnabled = !locked
        binding.blogPublishBtn.isEnabled = !locked &&
            binding.blogTitleInput.text?.isNotBlank() == true
        binding.composeBackBtn.isEnabled = !locked
        binding.blogPublishBtn.text = if (locked) {
            getString(R.string.blog_publishing)
        } else {
            getString(R.string.blog_publish)
        }
    }

    private fun setStatus(msg: String) {
        binding.composeStatus.text = msg
        binding.composeStatus.visibility = if (msg.isBlank()) View.GONE else View.VISIBLE
    }

    private fun describeProgress(phase: EtchSigner.Progress): String = when (phase) {
        EtchSigner.Progress.CollectingQuotes -> "Collecting quotes…"
        EtchSigner.Progress.QuotesReady -> "Quotes ready — review cost"
        EtchSigner.Progress.SwitchingChain -> "Switching wallet network…"
        EtchSigner.Progress.CheckingAllowance -> "Checking ANT allowance…"
        EtchSigner.Progress.ApprovingToken -> "Approving ANT spending…"
        is EtchSigner.Progress.WaitingForApprove -> "Waiting for approve confirmation…"
        EtchSigner.Progress.SigningPayment -> "Signing payment…"
        is EtchSigner.Progress.WaitingForPayment -> "Waiting for payment confirmation…"
        is EtchSigner.Progress.PaidAwaitingFinalize -> "Payment confirmed — storing post…"
        EtchSigner.Progress.FinalizingUpload -> "Finalizing — writing chunks…"
    }

    // ─── cost prompt ──────────────────────────────────────────────

    private suspend fun promptCostConfirm(
        totalAmountAtto: String,
        dataSize: Int,
        needsApproval: Boolean,
    ): BigInteger? = suspendCancellableCoroutine { cont ->
        val costAnt = formatTokenBalance(totalAmountAtto)
        val sizeStr = PasteUtils.formatSize(dataSize)

        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            val pad = (16 * resources.displayMetrics.density).toInt()
            setPadding(pad, pad, pad, 0)
        }
        layout.addView(TextView(this).apply {
            text = "Size: $sizeStr\nCost: $costAnt ANT\n\n" +
                "You'll pay this on Arbitrum to store the post permanently on the " +
                "Autonomi network. Reads are free for anyone with the address (or QR)."
            setTextColor(0xFFf5f2eb.toInt())
        })

        var budgetInput: EditText? = null
        if (needsApproval) {
            layout.addView(TextView(this).apply {
                text = "\nApprove budget (ANT):"
                setTextColor(0xFF8a8a8a.toInt())
            })
            budgetInput = EditText(this).apply {
                setText(DEFAULT_BUDGET_ANT.toString())
                inputType = android.text.InputType.TYPE_CLASS_NUMBER or
                    android.text.InputType.TYPE_NUMBER_FLAG_DECIMAL
                setSelectAllOnFocus(true)
                setTextColor(0xFFf5f2eb.toInt())
            }
            layout.addView(budgetInput)
            layout.addView(TextView(this).apply {
                text = "Pre-approving more means fewer wallet prompts next time."
                setTextColor(0xFF8a8a8a.toInt())
                textSize = 12f
            })
        }

        AlertDialog.Builder(this)
            .setTitle("Publish blog post?")
            .setView(layout)
            .setPositiveButton("Publish") { _, _ ->
                if (!cont.isActive) return@setPositiveButton
                val budgetAnt = budgetInput?.text?.toString()?.toBigDecimalOrNull()
                    ?: BigDecimal(DEFAULT_BUDGET_ANT)
                val budgetAtto = budgetAnt.multiply(BigDecimal.TEN.pow(18)).toBigInteger()
                val minRequired = BigInteger(totalAmountAtto)
                cont.resume(budgetAtto.max(minRequired))
            }
            .setNegativeButton("Cancel") { _, _ ->
                if (cont.isActive) cont.resume(null)
            }
            .setOnCancelListener { if (cont.isActive) cont.resume(null) }
            .show()
    }

    // ─── result state ─────────────────────────────────────────────

    private fun showResult(address: String, title: String) {
        publishedAddress = address
        publishedTitle = title
        binding.resultTitle.text = title
        binding.resultAddress.text = address

        // Render the same branded card we share so users can preview before sending.
        val qrCard = QrShare.renderCardFor(address, title)
        if (qrCard != null) binding.resultQr.setImageBitmap(qrCard)

        binding.composeRoot.visibility = View.GONE
        binding.resultRoot.visibility = View.VISIBLE
    }

    private fun resetToCompose() {
        binding.blogTitleInput.setText("")
        binding.blogBodyInput.setText("")
        binding.composeStatus.text = ""
        binding.composeStatus.visibility = View.GONE
        setComposingLocked(false)
        publishedAddress = null
        publishedTitle = null
        binding.resultRoot.visibility = View.GONE
        binding.composeRoot.visibility = View.VISIBLE
        binding.blogTitleInput.requestFocus()
    }

    private fun copyAddressToClipboard() {
        val addr = publishedAddress ?: return
        val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        cm.setPrimaryClip(ClipData.newPlainText("blog post address", addr))
        showSnackbar("Address copied")
    }

    private fun shareCurrentQr() {
        val addr = publishedAddress ?: return
        val ok = QrShare.share(this, addr, publishedTitle)
        if (!ok) showSnackbar("Couldn't render the QR card")
    }

    private fun openInExternalViewer() {
        val addr = publishedAddress ?: return
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("autonomi://$addr"))
        try {
            startActivity(intent)
        } catch (_: Exception) {
            showSnackbar("No app installed to open autonomi:// links — install fetch>it.")
        }
    }

    // ─── small helpers ───────────────────────────────────────────

    private fun showSnackbar(msg: String) {
        Snackbar.make(binding.root, msg, Snackbar.LENGTH_LONG).show()
    }

    private fun formatTokenBalance(atto: String): String = try {
        val value = BigDecimal(atto).divide(BigDecimal.TEN.pow(18), 4, RoundingMode.HALF_UP)
        if (value.compareTo(BigDecimal.ZERO) == 0) "0"
        else value.stripTrailingZeros().toPlainString()
    } catch (_: Exception) {
        atto
    }

    companion object {
        // Same default as MainActivity's confirm dialog — pre-approving 20 ANT
        // covers many posts before the next wallet prompt.
        private const val DEFAULT_BUDGET_ANT = 20
    }
}
