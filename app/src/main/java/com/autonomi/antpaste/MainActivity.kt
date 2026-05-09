package com.autonomi.antpaste

import android.animation.AnimatorSet
import android.animation.ObjectAnimator
import android.animation.ValueAnimator
import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.provider.OpenableColumns
import android.provider.Settings
import android.util.Log
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine
import android.view.View
import android.view.animation.AccelerateDecelerateInterpolator
import android.view.animation.OvershootInterpolator
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.core.widget.addTextChangedListener
import androidx.lifecycle.lifecycleScope
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.autonomi.antpaste.databinding.ActivityMainBinding
import com.autonomi.antpaste.chainmark.ArbiscanIndexer
import com.autonomi.antpaste.chainmark.ChainmarkController
import com.autonomi.antpaste.chainmark.ChainmarkEntry
import com.autonomi.antpaste.chainmark.ChainmarkKeyManager
import com.autonomi.antpaste.chainmark.WireEntry
import com.autonomi.antpaste.net.ConnectionManager
import com.autonomi.antpaste.net.ProgressTail
import com.autonomi.antpaste.ui.ResultCardView
import com.autonomi.antpaste.ui.WalletModalHost
import com.autonomi.antpaste.ui.showEtchHistory
import com.autonomi.antpaste.ui.showFullScreenTextDialog
import com.autonomi.antpaste.vault.EtchSigner
import com.autonomi.antpaste.vault.ResumableEtch
import com.autonomi.antpaste.vault.ResumableEtchStore
import com.autonomi.antpaste.wallet.EvmRpc
import com.autonomi.antpaste.wallet.SessionState
import com.google.android.material.bottomsheet.BottomSheetDialog
import com.google.android.material.snackbar.Snackbar
import org.json.JSONArray
import org.json.JSONObject
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import uniffi.ant_ffi.Client
import java.math.BigDecimal
import java.math.BigInteger
import java.math.RoundingMode

/**
 * First line of a Throwable's message — strips nested stack traces that
 * Reown's SDK stuffs into outer throwables via `stackTraceToString()`.
 * Keeps status banners readable instead of painting a wall of text.
 */
private fun Throwable.shortMessage(): String =
    message?.lineSequence()?.firstOrNull()?.trim()?.takeIf { it.isNotEmpty() }
        ?: javaClass.simpleName

class MainActivity : AppCompatActivity() {

    companion object {
        // etchit brand palette (ARGB ints for Kotlin use)
        const val INK = 0xFF0a0a0a.toInt()
        const val INK_2 = 0xFF141414.toInt()
        const val INK_3 = 0xFF1c1c1c.toInt()
        const val COPPER = 0xFFc9732b.toInt()
        const val COPPER_BRIGHT = 0xFFe58a3f.toInt()
        const val BONE = 0xFFf5f2eb.toInt()
        const val ASH = 0xFF8a8a8a.toInt()
        // Between ash and bone — used for in-progress status lines so they're
        // readable without glowing.
        const val STATUS_MUTED_ACTIVE = 0xFFb8b3a6.toInt()
        const val STATUS_GREEN = 0xFF9ece6a.toInt()
        const val STATUS_RED = 0xFFf7768e.toInt()
        const val MIN_BACKUP_PASSWORD_LEN = 8

        const val MAX_ATTACHMENT_BYTES = 20L * 1024 * 1024
        val TEXT_MIME_TYPES = arrayOf(
            "text/*",
            "application/json",
            "application/xml",
            "application/x-yaml",
        )

        // ResumableEtch persistence (encrypted-prefs key, max-age) lives in
        // ResumableEtchStore now. Constants below are app-level UI concerns.

        /** Warmup peer-count target — same as the prior first-touch gate. */
        private const val WARMUP_TARGET_PEERS = 10
        /** How long the peer count must stay ≥ target before painting
         *  Connected. Avoids the flicker when the FFI's background DHT
         *  bootstrap briefly dips peer count after returning early. */
        private const val WARMUP_SUSTAINED_MS = 3_000L
        /** Hard cap on warmup wait time. Was 10s; bumped to 15s to give
         *  the sustained-target gate enough headroom on slow networks. */
        private const val WARMUP_CAP_MS = 15_000L
    }

    private lateinit var binding: ActivityMainBinding
    private lateinit var prefs: SharedPreferences
    private lateinit var encryptedPrefs: SharedPreferences
    private lateinit var resultCard: ResultCardView

    private val attachTextFileLauncher: ActivityResultLauncher<Array<String>> =
        registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
            uri?.let { handleAttachedTextFile(it) }
        }

    // Holds the text to be saved by the SAF launcher — captured at the moment
    // of launch (double-tap → "Save as file…") and consumed in the callback.
    private var pendingTextToSave: String? = null
    private val saveTextLauncher: ActivityResultLauncher<String> =
        registerForActivityResult(ActivityResultContracts.CreateDocument("text/plain")) { uri ->
            val text = pendingTextToSave
            pendingTextToSave = null
            if (uri == null || text == null) return@registerForActivityResult
            try {
                contentResolver.openOutputStream(uri)?.use { it.write(text.toByteArray(Charsets.UTF_8)) }
                Snackbar.make(binding.root, "Saved", Snackbar.LENGTH_SHORT)
                    .setBackgroundTint(INK_3)
                    .setTextColor(STATUS_GREEN)
                    .show()
            } catch (e: Exception) {
                showStatus("Save failed: ${e.shortMessage()}", isError = true)
            }
        }

    private var nativeClient: Client? = null
    private var storeJob: Job? = null
    private lateinit var etchHistory: EtchHistory
    private lateinit var privateDataStore: PrivateDataStore
    private lateinit var chainmarkController: ChainmarkController
    private lateinit var opHelper: OperationHelper
    private var networkInfoJob: Job? = null
    private var progressTailJob: Job? = null
    private lateinit var resumableEtchStore: ResumableEtchStore

    /** Reown AppKit session held by the Application instance — one per process. */
    private val walletSession by lazy {
        (application as EtchitApplication).walletSession
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)
        prefs = getSharedPreferences("ant_paste", Context.MODE_PRIVATE)
        resultCard = ResultCardView(
            activity = this,
            binding = binding,
            onShowStatus = ::showStatus,
            onCopy = ::copyToClipboard,
            onHaptic = ::hapticSuccess,
            onBackupDetected = ::promptRestoreBackup,
        )

        val masterKey = MasterKey.Builder(this)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        encryptedPrefs = EncryptedSharedPreferences.create(
            this, "ant_paste_secure", masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )

        etchHistory = EtchHistory(prefs)
        privateDataStore = PrivateDataStore(encryptedPrefs)
        resumableEtchStore = ResumableEtchStore(encryptedPrefs)
        val walletSignerForChainmark = (application as EtchitApplication).walletSigner
        chainmarkController = ChainmarkController(
            keyManager = ChainmarkKeyManager(encryptedPrefs, walletSignerForChainmark),
            indexer = ArbiscanIndexer(
                baseUrl = prefs.getString("chainmark_indexer_url", null)?.takeIf { it.isNotBlank() } ?: ArbiscanIndexer.DEFAULT_BASE_URL,
                apiKey = prefs.getString("chainmark_indexer_api_key", null)?.takeIf { it.isNotBlank() },
            ),
            walletSigner = walletSignerForChainmark,
        )
        opHelper = OperationHelper(this)

        // Restore any persisted pending etch. The resume Snackbar fires
        // later, in connectToNetwork's success path, once nativeClient
        // is ready.
        resumableEtchStore.loadPersisted()?.let { restored ->
            Log.i(
                "ant-paste",
                "MainActivity: restored pending etch — uploadId=${restored.prepared.uploadId} " +
                    "paidTxHash=${restored.paidTxHash ?: "<none>"} " +
                    "ageSec=${(System.currentTimeMillis() - restored.prepared.createdAtMs) / 1000}",
            )
            resumableEtchStore.restore(restored)
        }

        runLegacyCleanup()
        setupButtons()
        animateEntrance()
        updateWalletStatus()

        binding.walletModalHost.setContent {
            WalletModalHost(walletSession)
        }

        if (!prefs.getBoolean(Terms.ACCEPTED_KEY, false)) {
            showTermsAcceptanceDialog()
        } else {
            continueStartup()
        }
    }

    private fun continueStartup() {
        promptBatteryOptimization()
        requestNotificationPermission()
        handleIncomingShare()
        startProgressTail()
        binding.root.post { connectToNetwork() }
    }

    private fun showTermsAcceptanceDialog() {
        val dialog = AlertDialog.Builder(this)
            .setTitle("etchit — Terms of Use")
            .setMessage(Terms.TEXT)
            .setCancelable(false)
            .setPositiveButton("Accept and continue") { d, _ ->
                prefs.edit().putBoolean(Terms.ACCEPTED_KEY, true).apply()
                d.dismiss()
                continueStartup()
            }
            .setNegativeButton("Decline") { _, _ -> finish() }
            .create()
        dialog.show()
    }

    private fun showTermsReadOnlyDialog() {
        AlertDialog.Builder(this)
            .setTitle("etchit — Terms of Use")
            .setMessage(Terms.TEXT)
            .setPositiveButton("Close") { d, _ -> d.dismiss() }
            .show()
    }

    /**
     * Activity is `launchMode="singleTask"`, so a deep-link return from
     * an external wallet (`etchit-wc://request`) lands here instead of
     * creating a new Activity. AppKit's SignClient picks up the session
     * state change via its own delegate; this hook just forwards the URI
     * into [walletSession] for logging.
     */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val data = intent.data
        if (data?.scheme == "etchit-wc") {
            Log.i("ant-paste", "WalletConnect deep-link received: $data")
            walletSession.onDeepLink(data.toString())
        }
    }

    override fun onDestroy() {
        // lifecycleScope cancels storeJob / fetchJob / privateRetrieveJob
        // automatically; the persisted ResumableEtch lets the next launch
        // pick up where we left off. Auxiliary jobs are cancelled
        // explicitly for symmetry.
        Log.i(
            "ant-paste",
            "MainActivity.onDestroy: storeJob=${storeJob?.isActive == true} " +
                "fetchJob=${fetchJob?.isActive == true} " +
                "privateRetrieveJob=${privateRetrieveJob?.isActive == true} " +
                "isFinishing=$isFinishing isChangingConfigurations=$isChangingConfigurations",
        )
        networkInfoJob?.cancel()
        progressTailJob?.cancel()
        walletStatusJob?.cancel()
        super.onDestroy()
    }

    // ── Setup ──────────────────────────────────────────────────────

    private fun setupButtons() {
        binding.swipeRefresh.setOnRefreshListener {
            handleSwipeRefresh()
        }

        binding.attachButton.setOnClickListener {
            hapticTick()
            attachTextFileLauncher.launch(TEXT_MIME_TYPES)
        }

        // Double-tap on the etch input opens a fullscreen editor — useful when
        // the typed/pasted text is much larger than the input box. Closing the
        // editor commits the new text back. Save-as-file in the editor lets
        // you keep a local copy before etching.
        val contentInputGd = android.view.GestureDetector(this, object : android.view.GestureDetector.SimpleOnGestureListener() {
            override fun onDoubleTap(e: android.view.MotionEvent): Boolean {
                showFullScreenTextDialog(
                    activity = this@MainActivity,
                    title = "",
                    initialText = binding.contentInput.text.toString(),
                    editable = true,
                    onCommit = { newText ->
                        binding.contentInput.setText(newText)
                        binding.contentInput.setSelection(newText.length)
                    },
                    onSave = ::launchSaveText,
                )
                return true
            }
        })
        binding.contentInput.setOnTouchListener { v, event ->
            v.parent?.requestDisallowInterceptTouchEvent(true)
            if (event.actionMasked == android.view.MotionEvent.ACTION_UP ||
                event.actionMasked == android.view.MotionEvent.ACTION_CANCEL) {
                v.parent?.requestDisallowInterceptTouchEvent(false)
            }
            contentInputGd.onTouchEvent(event)
            false
        }

        // Same gesture on the fetch result content — long content is currently
        // truncated to maxLines=20 with an ellipsis, so double-tap opens a
        // read-only fullscreen view of the entire fetched text plus a
        // Save-as-file action.
        val resultContentGd = android.view.GestureDetector(this, object : android.view.GestureDetector.SimpleOnGestureListener() {
            override fun onDoubleTap(e: android.view.MotionEvent): Boolean {
                showFullScreenTextDialog(
                    activity = this@MainActivity,
                    title = binding.resultTitle.text?.toString().orEmpty().ifBlank { "Fetched content" },
                    initialText = binding.resultContent.text.toString(),
                    editable = false,
                    onSave = ::launchSaveText,
                )
                return true
            }
        })
        binding.resultContent.isClickable = true
        binding.resultContent.setOnTouchListener { _, event ->
            resultContentGd.onTouchEvent(event)
            false
        }

        binding.pasteButton.setOnClickListener {
            hapticTick()
            createPaste()
        }
        binding.retrieveButton.setOnClickListener {
            hapticTick()
            retrievePaste()
        }
        binding.copyAddressBtn.setOnClickListener {
            copyToClipboard(binding.resultAddress.text.toString(), "Address")
        }
        binding.copyContentBtn.setOnClickListener {
            copyToClipboard(binding.resultContent.text.toString(), "Content")
        }
        binding.resultAddress.setOnClickListener {
            copyToClipboard(binding.resultAddress.text.toString(), "Address")
        }
        binding.settingsButton.setOnClickListener {
            hapticTick()
            showSettings()
        }
        binding.shareButton.setOnClickListener {
            hapticTick()
            shareResult()
        }
        binding.pasteLoading.setOnClickListener {
            hapticTick()
            storeJob?.cancel()
            fetchJob?.cancel()
            privateRetrieveJob?.cancel()
        }
        binding.privateSwitch.setOnCheckedChangeListener { _, isChecked ->
            binding.pasteButton.text = if (isChecked) "Private Etch" else "Etch"
        }
    }

    /** One-shot cleanup of legacy preferences from prior versions. */
    private fun runLegacyCleanup() {
        if (prefs.getBoolean("legacy_cleanup_done", false)) return
        encryptedPrefs.edit().remove("wallet_private_key").apply()
        prefs.edit()
            .remove("wallet_configured")
            .remove("evm_rpc_url")
            .remove("evm_payment_token_address")
            .remove("evm_data_payments_address")
            .remove("wallet_address_cache")
            .remove("wallet_balance_cache")
            .remove("confirm_etch_cost")
            .putBoolean("legacy_cleanup_done", true)
            .apply()
    }

    private fun promptBatteryOptimization() {
        if (prefs.getBoolean("battery_prompt_done", false)) return
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        if (pm.isIgnoringBatteryOptimizations(packageName)) return

        prefs.edit().putBoolean("battery_prompt_done", true).apply()
        AlertDialog.Builder(this)
            .setTitle("Unrestricted battery")
            .setMessage(
                "etchit needs to maintain a peer-to-peer connection " +
                "while etching and fetching. Please set the battery " +
                "mode to \"Unrestricted\" so Android doesn't kill the " +
                "connection in the background."
            )
            .setPositiveButton("Open settings") { _, _ ->
                val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                    data = Uri.parse("package:$packageName")
                }
                startActivity(intent)
            }
            .setNegativeButton("Later", null)
            .show()
    }

    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 100)
            }
        }
    }

    private fun handleIncomingShare() {
        if (intent?.action == Intent.ACTION_SEND && intent.type == "text/plain") {
            intent.getStringExtra(Intent.EXTRA_TEXT)?.let { sharedText ->
                binding.contentInput.setText(sharedText)
                binding.titleInput.setText(intent.getStringExtra(Intent.EXTRA_SUBJECT) ?: "")
            }
        }
    }

    // ── Animations ─────────────────────────────────────────────────

    private fun animateEntrance() {
        val views = listOf(
            binding.createSection,
        )
        views.forEachIndexed { index, view ->
            view.alpha = 0f
            view.translationY = 30f
            view.animate()
                .alpha(1f)
                .translationY(0f)
                .setDuration(450)
                .setStartDelay(100L + index * 80L)
                .setInterpolator(AccelerateDecelerateInterpolator())
                .start()
        }
    }
    private fun animateButtonPress(view: View) {
        val scaleDown = AnimatorSet().apply {
            playTogether(
                ObjectAnimator.ofFloat(view, "scaleX", 1f, 0.96f),
                ObjectAnimator.ofFloat(view, "scaleY", 1f, 0.96f),
            )
            duration = 80
        }
        val scaleUp = AnimatorSet().apply {
            playTogether(
                ObjectAnimator.ofFloat(view, "scaleX", 0.96f, 1f),
                ObjectAnimator.ofFloat(view, "scaleY", 0.96f, 1f),
            )
            duration = 120
            interpolator = OvershootInterpolator(2f)
        }
        AnimatorSet().apply {
            playSequentially(scaleDown, scaleUp)
            start()
        }
    }

    private fun pulseStatusDot() {
        val dot = binding.statusDot
        val pulse = ObjectAnimator.ofFloat(dot, "alpha", 1f, 0.3f, 1f).apply {
            duration = 1200
            repeatCount = ValueAnimator.INFINITE
            interpolator = AccelerateDecelerateInterpolator()
        }
        pulse.start()
        dot.tag = pulse  // store ref to cancel later
    }

    private fun stopStatusPulse() {
        (binding.statusDot.tag as? ObjectAnimator)?.cancel()
        binding.statusDot.alpha = 1f
    }

    // ── Haptics ────────────────────────────────────────────────────

    private fun hapticTick() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    (getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager).defaultVibrator
                } else {
                    @Suppress("DEPRECATION")
                    getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
                }
                vibrator.vibrate(VibrationEffect.createPredefined(VibrationEffect.EFFECT_TICK))
            }
        } catch (_: Exception) {}
    }

    private fun hapticSuccess() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    (getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager).defaultVibrator
                } else {
                    @Suppress("DEPRECATION")
                    getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
                }
                vibrator.vibrate(VibrationEffect.createOneShot(30, VibrationEffect.DEFAULT_AMPLITUDE))
            }
        } catch (_: Exception) {}
    }

    // ── Network Connection ─────────────────────────────────────────

    private fun connectToNetwork() {
        setStatus("connecting", StatusState.CONNECTING)
        showStatus("Joining the network")
        pulseStatusDot()

        lifecycleScope.launch {
            val peers = ConnectionManager.readBootstrapPeers(prefs)
            if (peers.isEmpty()) {
                stopStatusPulse()
                setStatus("no peers", StatusState.OFFLINE)
                showStatus("No bootstrap peers configured. Open Settings.", isError = true)
                return@launch
            }

            Log.i("ant-paste", "P2P connect: peers=$peers")
            try {
                Log.i("ant-paste", "Calling Client.connect()...")
                showStatus("Joining the network...")
                val t0 = System.currentTimeMillis()
                nativeClient = withContext(Dispatchers.IO) {
                    withTimeout(45_000) { Client.connect(peers) }
                }
                Log.i("ant-paste", "Client.connect() returned in ${System.currentTimeMillis() - t0}ms")

                // Warm-up: wait until peer count has been ≥10 for at least
                // [WARMUP_SUSTAINED_MS]. The FFI's `start_node_with_warmup`
                // returns to us as soon as 1 peer attaches and the DHT
                // bootstrap continues in the background — so a naive
                // first-touch ≥10 gate paints "Connected" on a flaky high
                // that immediately drops back to 0-2 peers. Sustaining the
                // threshold avoids that flicker.
                showStatus("Joining the network…")
                val warmupStart = System.currentTimeMillis()
                var sustainedSince = -1L
                while (System.currentTimeMillis() - warmupStart < WARMUP_CAP_MS) {
                    val count = try {
                        withContext(Dispatchers.IO) { withTimeout(2_000) { nativeClient!!.peerCount().toInt() } }
                    } catch (_: Exception) { 0 }
                    if (count >= WARMUP_TARGET_PEERS) {
                        if (sustainedSince < 0) sustainedSince = System.currentTimeMillis()
                        if (System.currentTimeMillis() - sustainedSince >= WARMUP_SUSTAINED_MS) break
                    } else {
                        sustainedSince = -1L
                    }
                    delay(500)
                }

                stopStatusPulse()
                setStatus("Connected", StatusState.CONNECTED)
                binding.pasteButton.isEnabled = true
                binding.retrieveButton.isEnabled = true
                updateWalletStatus()
                startNetworkInfoRefresh()
                showStatus("Connected to the Autonomi network")

                // If a prior process left a pending etch persisted, offer
                // to finish it now that we have a live nativeClient.
                resumableEtchStore.current?.let { offerResumeFromPersisted(it) }
            } catch (e: TimeoutCancellationException) {
                Log.e("ant-paste", "Connection timed out after 45s", e)
                stopStatusPulse()
                setStatus("timeout", StatusState.OFFLINE)
                showStatus("Connection timed out. Check network.", isError = true)
            } catch (e: Exception) {
                Log.e("ant-paste", "Connection failed", e)
                stopStatusPulse()
                setStatus("offline", StatusState.OFFLINE)
                showStatus("Connection failed: ${e.shortMessage()}", isError = true)
            }
        }
    }

    private enum class StatusState { CONNECTING, CONNECTED, OFFLINE }

    private fun setStatus(text: String, state: StatusState) {
        binding.statusIndicator.text = text
        val dotDrawable = binding.statusDot.background as? GradientDrawable
            ?: (binding.statusDot.background?.mutate() as? GradientDrawable)

        val color = when (state) {
            StatusState.CONNECTING -> COPPER_BRIGHT
            StatusState.CONNECTED -> STATUS_GREEN
            StatusState.OFFLINE -> STATUS_RED
        }
        dotDrawable?.setColor(color)
        binding.statusIndicator.setTextColor(
            if (state == StatusState.CONNECTED) STATUS_GREEN else ASH
        )
    }

    // ── Wallet Status ─────────────────────────────────────────────

    private var walletStatusJob: Job? = null
    private var antBalanceJob: Job? = null
    private var lastAntBalanceWei: java.math.BigInteger? = null

    private fun formatAnt(atto: java.math.BigInteger): String {
        val one = java.math.BigInteger.TEN.pow(18)
        val whole = atto.divide(one)
        val frac = atto.mod(one)
            .multiply(java.math.BigInteger.valueOf(10_000L))
            .divide(one)
        return "$whole.${frac.toString().padStart(4, '0')}"
    }

    private suspend fun fetchAntBalance(address: String): java.math.BigInteger? {
        return try {
            val rpc = com.autonomi.antpaste.wallet.EvmRpc(BuildConfig.RPC_URL)
            val data = com.autonomi.antpaste.wallet.Erc20.encodeBalanceOf(address)
            val result = rpc.ethCall(BuildConfig.ANT_TOKEN_ADDRESS, data)
            if (result.size == 32) com.autonomi.antpaste.wallet.Erc20.decodeUint256(result) else null
        } catch (e: Exception) {
            Log.w("ant-paste", "ANT balance fetch failed: ${e.message}")
            null
        }
    }

    private fun renderConnectedWallet(address: String) {
        val short = "${address.take(6)}…${address.takeLast(4)}"
        val bal = lastAntBalanceWei
        val text = if (bal != null) "Wallet: $short • ${formatAnt(bal)} ANT" else "Wallet: $short"
        binding.walletStatusText.text = text
        binding.walletStatusText.setTextColor(STATUS_GREEN)
    }

    // Periodic ANT-balance refresh while the wallet stays connected. Mirrors
    // the desktop client's 30s interval. Cheap eth_call, negligible cost.
    private fun startAntBalanceRefresh(address: String) {
        antBalanceJob?.cancel()
        antBalanceJob = lifecycleScope.launch {
            while (isActive) {
                val bal = fetchAntBalance(address)
                if (bal != null) {
                    lastAntBalanceWei = bal
                    renderConnectedWallet(address)
                }
                delay(30_000)
            }
        }
    }

    private fun stopAntBalanceRefresh() {
        antBalanceJob?.cancel()
        antBalanceJob = null
        lastAntBalanceWei = null
    }

    private fun updateWalletStatus() {
        binding.walletStatusText.visibility = View.VISIBLE

        // Reactively mirror walletSession.state so a restored session
        // shows the connected address immediately on launch, and any
        // relay-driven disconnect (stale session cleanup) updates the
        // status line without manual polling.
        walletStatusJob?.cancel()
        walletStatusJob = walletSession.state
            .onEach { s ->
                when (s) {
                    is SessionState.Connected -> {
                        renderConnectedWallet(s.address)
                        startAntBalanceRefresh(s.address)
                    }
                    SessionState.Connecting -> {
                        stopAntBalanceRefresh()
                        binding.walletStatusText.text = "Connecting wallet…"
                        binding.walletStatusText.setTextColor(COPPER_BRIGHT)
                    }
                    is SessionState.Error -> {
                        stopAntBalanceRefresh()
                        binding.walletStatusText.text = "Wallet error: ${s.reason}"
                        binding.walletStatusText.setTextColor(STATUS_RED)
                    }
                    SessionState.Disconnected -> {
                        stopAntBalanceRefresh()
                        binding.walletStatusText.text = "No wallet \u2014 read only"
                        binding.walletStatusText.setTextColor(ASH)
                    }
                }
            }
            .launchIn(lifecycleScope)
    }

    /** Start periodically refreshing the network info line (peer count). */
    private fun startNetworkInfoRefresh() {
        networkInfoJob?.cancel()
        binding.networkInfoText.visibility = View.VISIBLE
        networkInfoJob = lifecycleScope.launch {
            while (isActive) {
                refreshNetworkInfo()
                delay(15_000)
            }
        }
    }

    private suspend fun refreshNetworkInfo() {
        val client = nativeClient ?: return
        val peerCount = try {
            withContext(Dispatchers.IO) {
                withTimeout(5_000) { client.peerCount() }
            }
        } catch (_: Exception) {
            return  // peer count query failed — leave label as-is
        }
        binding.networkInfoText.text = "${peerCount} peers"
        // Red when peers drop to 0 so the user sees the dip rather than
        // staring at a "Connected" status while operations silently
        // stall. The FFI usually self-recovers; we just surface the
        // transient state honestly.
        binding.networkInfoText.setTextColor(if (peerCount == 0UL) STATUS_RED else ASH)
    }

    private fun truncateAddress(addr: String): String {
        if (addr.length <= 12) return addr
        return "${addr.take(6)}...${addr.takeLast(4)}"
    }

    // ── Create Paste ───────────────────────────────────────────────

    private fun createPaste() {
        val content = binding.contentInput.text.toString()
        if (content.isBlank()) {
            showStatus("Content cannot be empty", isError = true)
            return
        }

        if (!walletSession.isConnected) {
            Snackbar.make(binding.root, "Wallet required to etch", Snackbar.LENGTH_LONG)
                .setBackgroundTint(INK_3)
                .setTextColor(STATUS_RED)
                .setAction("Settings") { showSettings() }
                .setActionTextColor(COPPER)
                .show()
            return
        }

        val title = binding.titleInput.text.toString()
        animateButtonPress(binding.pasteButton)

        val isPrivate = binding.privateSwitch.isChecked

        binding.pasteButton.visibility = View.INVISIBLE
        binding.pasteLoading.visibility = View.VISIBLE
        binding.contentInput.isEnabled = false
        binding.titleInput.isEnabled = false
        binding.privateSwitch.isEnabled = false
        showStatus("Etching to the network...")

        // Starting a fresh etch invalidates any previous resumable state —
        // we're about to prepare a new upload with new quotes.
        resumableEtchStore.set(null)

        storeJob = lifecycleScope.launch {
            opHelper.start("Starting…")
            try {
                val envelope = buildEnvelope(content, title)
                val data = envelope.toByteArray(Charsets.UTF_8)

                val signer = EtchSigner(
                    nativeClient = nativeClient!!,
                    walletSession = walletSession,
                    walletSigner = (application as EtchitApplication).walletSigner,
                    evmRpc = EvmRpc(BuildConfig.RPC_URL),
                )

                val result = withContext(Dispatchers.IO) {
                    signer.etch(
                        data = data,
                        `private` = isPrivate,
                        costPrompt = { totalAtto, dataSize, needsApproval ->
                            withContext(Dispatchers.Main) {
                                promptEtchCost(totalAtto, dataSize, needsApproval)
                            }?.also { budget ->
                                // Persist the user's chosen budget the
                                // moment they confirm — has to land before
                                // any later wallet/FFI failure unwinds out
                                // of withContext, otherwise a retry would
                                // approve only one etch worth instead of
                                // the full session budget.
                                resumableEtchStore.current?.let {
                                    resumableEtchStore.set(it.copy(approveBudget = budget))
                                }
                            }
                        },
                        onProgress = etchProgressCallback(isBackup = false),
                        onPrepared = { prepared ->
                            // Seed with totalAtto so resumable state is
                            // valid even if the wallet fails before the
                            // user picks a budget; updated above once they
                            // confirm the cost prompt.
                            resumableEtchStore.set(ResumableEtch(
                                prepared = prepared,
                                approveBudget = prepared.totalAtto,
                                title = title,
                                content = content,
                            ))
                        },
                    )
                }

                if (result == null) {
                    resumableEtchStore.set(null)
                    showStatus("Cancelled")
                    return@launch
                }

                val displayTitle = title.ifEmpty { "Untitled" }
                when (result) {
                    is EtchSigner.EtchResult.Public -> {
                        resultCard.show(displayTitle, result.address, content)
                        showStatus("Etched permanently \u2022 ${formatSize(data.size)} \u2022 ${result.chunksStored} chunks")
                        etchHistory.add(result.address, displayTitle)
                    }
                    is EtchSigner.EtchResult.Private -> {
                        val dmId = privateDataStore.save(displayTitle, result.dataMapHex)
                        etchHistory.addPrivate(displayTitle, dmId)
                        resultCard.show(displayTitle, "Private \u2022 stored on device", content)
                        binding.resultAddress.setTextColor(STATUS_GREEN)
                        binding.copyAddressBtn.visibility = View.GONE
                        binding.shareButton.visibility = View.GONE
                        showStatus("Etched privately \u2022 ${formatSize(data.size)} \u2022 ${result.chunksStored} chunks")
                    }
                }

                resumableEtchStore.set(null)
                binding.contentInput.text.clear()
                binding.titleInput.text.clear()

            } catch (e: CancellationException) {
                showStatus("Cancelled", isError = false)
                throw e
            } catch (e: TimeoutCancellationException) {
                showStatus("Etch timed out after 3 minutes", isError = true)
            } catch (e: Exception) {
                Log.e("ant-paste", "etch flow failed (${e.javaClass.simpleName}): ${e.message}", e)
                showStatus("Failed: ${e.shortMessage()}", isError = true)
                offerRetryIfResumable()
            } finally {
                opHelper.finish()
                binding.pasteLoading.visibility = View.GONE
                binding.pasteButton.visibility = View.VISIBLE
                binding.contentInput.isEnabled = true
                binding.titleInput.isEnabled = true
                binding.privateSwitch.isEnabled = true
                storeJob = null
            }
        }
    }

    /**
     * Shared progress-label callback for the etch flow. Used by both the
     * initial attempt and [retryResumableEtch] so status text is
     * consistent whether we're running from scratch or resuming signing.
     *
     * Fires a chime + haptic + notification the moment quote collection
     * ends — that phase can take many minutes, and the user often puts
     * the phone down. We detect the transition OUT of [CollectingQuotes]
     * on the first non-collecting phase.
     */
    private fun etchProgressCallback(isBackup: Boolean): (EtchSigner.Progress) -> Unit {
        var quotesDoneChimed = false
        return { phase ->
            // Persist the payment hash via setResumableEtch so a retry
            // after process death can finalize-only without re-paying.
            // durable=true forces a synchronous commit() — losing this
            // write to a kill-during-async-flush is the exact failure
            // mode the persistence is meant to prevent.
            if (phase is EtchSigner.Progress.PaidAwaitingFinalize) {
                resumableEtchStore.current?.let {
                    resumableEtchStore.set(it.copy(paidTxHash = phase.txHash), durable = true)
                }
            }
            val text = when (phase) {
                EtchSigner.Progress.CollectingQuotes -> "Collecting quotes…"
                EtchSigner.Progress.QuotesReady -> "Quotes ready — review cost"
                EtchSigner.Progress.SwitchingChain -> "Switching wallet network…"
                EtchSigner.Progress.CheckingAllowance -> "Checking ANT allowance…"
                EtchSigner.Progress.ApprovingToken -> "Approving ANT spending…"
                is EtchSigner.Progress.WaitingForApprove -> "Waiting for approve confirmation…"
                EtchSigner.Progress.SigningPayment -> "Signing payment…"
                is EtchSigner.Progress.WaitingForPayment -> "Waiting for payment confirmation…"
                is EtchSigner.Progress.PaidAwaitingFinalize -> "Payment confirmed — storing data…"
                EtchSigner.Progress.FinalizingUpload ->
                    if (isBackup) "Finalizing backup…" else "Finalizing upload…"
            }
            lifecycleScope.launch(Dispatchers.Main) {
                showStatus(text)
                opHelper.updateProgress(this@MainActivity, text)
            }
            if (!quotesDoneChimed && phase !is EtchSigner.Progress.CollectingQuotes) {
                quotesDoneChimed = true
                opHelper.notifyQuotesReady()
            }
            if (phase is EtchSigner.Progress.ApprovingToken ||
                phase is EtchSigner.Progress.SigningPayment) {
                opHelper.notifyApprovalNeeded()
            }
        }
    }

    /**
     * Show a Snackbar offering to recover the in-progress etch. Two paths
     * depending on whether on-chain payment already landed:
     *
     * - `paidTxHash == null` (Case A: wallet failed pre-payment) — the
     *   FFI's prepared upload is still alive; tap Retry to re-run the
     *   wallet flow without re-collecting quotes.
     *
     * - `paidTxHash != null` (Case B: payment landed, finalize failed)
     *   — the FFI's prepared upload was consumed by `take_pending` on
     *   the failed finalize attempt and can't be reused, so a same-
     *   `uploadId` retry would just hit NotFound. Instead, tap Re-etch
     *   to start a fresh etch with the same content; the now-deterministic
     *   envelope means already-stored chunks are skipped via
     *   `Error::AlreadyStored` and the user only pays for the chunks
     *   that didn't land last time.
     */
    private fun offerRetryIfResumable() {
        val resume = resumableEtchStore.current ?: return
        if (resume.paidTxHash != null) {
            offerReEtchAfterFinalizeFail(resume)
        } else {
            Snackbar.make(
                binding.root,
                "Wallet failed — quotes still valid, retry signing?",
                Snackbar.LENGTH_INDEFINITE,
            )
                .setAction("Retry") { retryResumableEtch(resume) }
                .setActionTextColor(COPPER)
                .show()
        }
    }

    /**
     * Offer to recover an etch persisted from a prior process. Routes the
     * same two cases as [offerRetryIfResumable] — Retry vs Re-etch —
     * picked by `paidTxHash`.
     */
    private fun offerResumeFromPersisted(state: ResumableEtch) {
        if (state.paidTxHash != null) {
            offerReEtchAfterFinalizeFail(state)
        } else {
            val ageMin = (System.currentTimeMillis() - state.prepared.createdAtMs) / 60_000
            Snackbar.make(
                binding.root,
                "Previous etch wasn't completed (${ageMin}m ago). Resume?",
                Snackbar.LENGTH_INDEFINITE,
            )
                .setAction("Resume") { retryResumableEtch(state) }
                .setActionTextColor(COPPER)
                .show()
        }
    }

    private fun offerReEtchAfterFinalizeFail(state: ResumableEtch) {
        Snackbar.make(
            binding.root,
            "Etch couldn't finalize — re-etch with same content? (paid chunks reused)",
            Snackbar.LENGTH_INDEFINITE,
        )
            .setAction("Re-etch") { reEtchFromResumable(state) }
            .setActionTextColor(COPPER)
            .show()
    }

    /**
     * Re-run an etch from scratch using content from a stuck [ResumableEtch].
     * The deterministic envelope means same `(content, title)` produces the
     * same chunk addresses, so chunks that did store on the failed attempt
     * are skipped via the FFI's already-stored path and only the missing
     * chunks need fresh payment.
     */
    private fun reEtchFromResumable(state: ResumableEtch) {
        if (!walletSession.isConnected) {
            showStatus("Wallet required to re-etch", isError = true)
            return
        }
        // Drop the broken state — about to start a fresh etch that
        // doesn't depend on it.
        resumableEtchStore.set(null)
        binding.contentInput.setText(state.content)
        binding.titleInput.setText(state.title)
        binding.privateSwitch.isChecked = state.prepared.isPrivate
        createPaste()
    }

    /**
     * Resume a failed etch at the signing step. Reuses the FFI-side
     * PreparedEtch (uploadId + quotes) and the previously chosen approve
     * budget, so MetaMask pops up immediately with no repeat of the
     * quote-collection or cost-prompt phases.
     */
    private fun retryResumableEtch(resume: ResumableEtch) {
        // Wallet only needed if we still have to pay. With paidTxHash
        // set, signAndFinalize short-circuits to finalize-only and never
        // touches the wallet — so blocking on a stale WC session here
        // would trap the user with a paid-but-unfinalized etch.
        if (resume.paidTxHash == null && !walletSession.isConnected) {
            showStatus("Wallet required to retry", isError = true)
            return
        }
        binding.pasteButton.visibility = View.INVISIBLE
        binding.pasteLoading.visibility = View.VISIBLE
        binding.contentInput.isEnabled = false
        binding.titleInput.isEnabled = false
        binding.privateSwitch.isEnabled = false
        showStatus("Retrying signing…")

        val signer = EtchSigner(
            nativeClient = nativeClient!!,
            walletSession = walletSession,
            walletSigner = (application as EtchitApplication).walletSigner,
            evmRpc = EvmRpc(BuildConfig.RPC_URL),
        )
        val content = resume.content
        val title = resume.title
        val displayTitle = title.ifEmpty { "Untitled" }
        val data = buildEnvelope(content, title).toByteArray(Charsets.UTF_8)

        storeJob = lifecycleScope.launch {
            opHelper.start("Retrying signing…")
            try {
                val result = withContext(Dispatchers.IO) {
                    signer.signAndFinalize(
                        prepared = resume.prepared,
                        approveBudget = resume.approveBudget,
                        onProgress = etchProgressCallback(isBackup = resume.isBackup),
                        // If a prior attempt already paid on-chain, skip
                        // the wallet flow — without this the retry would
                        // double-charge the user for the same upload.
                        previouslyPaidTxHash = resume.paidTxHash,
                    )
                }
                when (result) {
                    is EtchSigner.EtchResult.Public -> {
                        resultCard.show(displayTitle, result.address, content)
                        showStatus("Etched permanently \u2022 ${formatSize(data.size)} \u2022 ${result.chunksStored} chunks")
                        etchHistory.add(result.address, displayTitle)
                    }
                    is EtchSigner.EtchResult.Private -> {
                        val dmId = privateDataStore.save(displayTitle, result.dataMapHex)
                        etchHistory.addPrivate(displayTitle, dmId)
                        resultCard.show(displayTitle, "Private \u2022 stored on device", content)
                        binding.resultAddress.setTextColor(STATUS_GREEN)
                        binding.copyAddressBtn.visibility = View.GONE
                        binding.shareButton.visibility = View.GONE
                        showStatus("Etched privately \u2022 ${formatSize(data.size)} \u2022 ${result.chunksStored} chunks")
                    }
                }
                resumableEtchStore.set(null)
                binding.contentInput.text.clear()
                binding.titleInput.text.clear()
            } catch (e: CancellationException) {
                showStatus("Cancelled", isError = false)
                throw e
            } catch (e: Exception) {
                Log.e("ant-paste", "etch retry failed (${e.javaClass.simpleName}): ${e.message}", e)
                // FFI's finalize consumes the prepared upload on the
                // first attempt; after process restart (or once the
                // first finalize ran), the upload id isn't in the new
                // Client's HashMap and we get NotFound. Clear the
                // resumable state for a clean "start over" rather than
                // an infinite retry loop.
                val isFfiNotFound = e.message?.contains("not found", ignoreCase = true) == true
                if (isFfiNotFound) {
                    resumableEtchStore.set(null)
                    showStatus("Previous etch can't be resumed — start a new one", isError = true)
                } else {
                    showStatus("Retry failed: ${e.shortMessage()}", isError = true)
                    offerRetryIfResumable()
                }
            } finally {
                opHelper.finish()
                binding.pasteLoading.visibility = View.GONE
                binding.pasteButton.visibility = View.VISIBLE
                binding.contentInput.isEnabled = true
                binding.titleInput.isEnabled = true
                binding.privateSwitch.isEnabled = true
                storeJob = null
            }
        }
    }

    /**
     * Confirmation dialog with the quoted etch cost and optional approve
     * budget. Returns `null` on cancel, or the chosen approve budget (in
     * atto) on confirm. When [needsApproval] is false the budget field is
     * hidden and the returned value is meaningless (but non-null).
     */
    private suspend fun promptEtchCost(
        totalAmountAtto: String,
        dataSize: Int,
        needsApproval: Boolean,
    ): BigInteger? = suspendCancellableCoroutine { cont ->
        val costAnt = formatTokenBalance(totalAmountAtto)
        val sizeStr = formatSize(dataSize)

        val layout = LinearLayout(this@MainActivity).apply {
            orientation = LinearLayout.VERTICAL
            val pad = (16 * resources.displayMetrics.density).toInt()
            setPadding(pad, pad, pad, 0)
        }

        val message = TextView(this@MainActivity).apply {
            text = "Size: $sizeStr\nCost: $costAnt ANT\n\n" +
                "You'll pay this amount on-chain plus a small ETH gas fee " +
                "to store this etch permanently on the Autonomi network. " +
                "Reads are always free."
            setTextColor(BONE)
        }
        layout.addView(message)

        var budgetInput: EditText? = null
        if (needsApproval) {
            val budgetLabel = TextView(this@MainActivity).apply {
                text = "\nApprove budget (ANT):"
                setTextColor(ASH)
                val lp = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                )
                layoutParams = lp
            }
            layout.addView(budgetLabel)

            budgetInput = EditText(this@MainActivity).apply {
                setText("20")
                inputType = android.text.InputType.TYPE_CLASS_NUMBER or
                    android.text.InputType.TYPE_NUMBER_FLAG_DECIMAL
                setSelectAllOnFocus(true)
                setTextColor(BONE)
            }
            layout.addView(budgetInput)

            val hint = TextView(this@MainActivity).apply {
                text = "Pre-approving a larger budget means fewer wallet " +
                    "prompts on future etches. Minimum is the etch cost."
                setTextColor(ASH)
                textSize = 12f
            }
            layout.addView(hint)
        }

        AlertDialog.Builder(this@MainActivity)
            .setTitle("Confirm etch")
            .setView(layout)
            .setPositiveButton("Etch") { _, _ ->
                if (!cont.isActive) return@setPositiveButton
                if (needsApproval && budgetInput != null) {
                    val budgetAnt = budgetInput.text.toString().toBigDecimalOrNull()
                    if (budgetAnt != null && budgetAnt.signum() > 0) {
                        val budgetAtto = budgetAnt.multiply(java.math.BigDecimal.TEN.pow(18))
                            .toBigInteger()
                        cont.resume(budgetAtto)
                    } else {
                        // Invalid input — fall back to the etch cost
                        cont.resume(BigInteger(totalAmountAtto))
                    }
                } else {
                    cont.resume(BigInteger.ZERO)
                }
            }
            .setNegativeButton("Cancel") { _, _ ->
                if (cont.isActive) cont.resume(null)
            }
            .setOnCancelListener { if (cont.isActive) cont.resume(null) }
            .show()
    }

    // ── Retrieve Paste ─────────────────────────────────────────────

    private var fetchJob: Job? = null

    private fun retrievePaste() {
        val address = binding.addressInput.text.toString().trim()
        if (address.length != 64) {
            showStatus("Address must be 64 hex characters", isError = true)
            return
        }

        animateButtonPress(binding.retrieveButton)

        // Hide everything, show spinner
        binding.createSection.visibility = View.GONE
        binding.fetchDivider.visibility = View.GONE
        binding.fetchSection.visibility = View.GONE
        binding.pasteLoading.visibility = View.VISIBLE
        binding.pasteLoadingText.text = "Fetching...  tap to cancel"
        showStatus("Fetching from the network...")

        fetchJob = lifecycleScope.launch {
            opHelper.start("Starting…")
            opHelper.updateProgress(this@MainActivity, "Fetching from the network…")
            try {
                val data = withContext(Dispatchers.IO) {
                    nativeClient!!.dataGetPublic(address)
                }

                resultCard.displayFetched(data, address)

            } catch (e: CancellationException) {
                showStatus("Cancelled")
                throw e
            } catch (e: Exception) {
                Log.e("ant-paste", "fetch failed (${e.javaClass.simpleName}): ${e.message}", e)
                showStatus("Not found: ${e.shortMessage()}", isError = true)
            } finally {
                opHelper.finish()
                binding.pasteLoading.visibility = View.GONE
                binding.pasteLoadingText.text = "Etching...  tap to cancel"
                binding.createSection.visibility = View.VISIBLE
                binding.fetchDivider.visibility = View.VISIBLE
                binding.fetchSection.visibility = View.VISIBLE
                fetchJob = null
            }
        }
    }

    // ── Settings ───────────────────────────────────────────────────

    private fun showSettings() {
        val dialog = BottomSheetDialog(this, com.autonomi.antpaste.R.style.SheetDialog)
        val view = layoutInflater.inflate(R.layout.dialog_settings, null)
        dialog.setContentView(view)

        val connectWalletBtn = view.findViewById<Button>(R.id.connectWalletBtn)
        val walletStatusLine = view.findViewById<TextView>(R.id.walletStatusLine)
        val peersInput = view.findViewById<EditText>(R.id.bootstrapPeersInput)

        val savedPeers = prefs.getString("bootstrap_peers", null)
        peersInput.setText(
            if (savedPeers.isNullOrBlank()) ConnectionManager.DEFAULT_PEERS_TEXT else savedPeers
        )

        connectWalletBtn.setOnClickListener {
            hapticTick()
            when (walletSession.state.value) {
                is SessionState.Connected -> walletSession.disconnect()
                SessionState.Connecting -> { /* already in flight */ }
                else -> {
                    dialog.dismiss()
                    walletSession.connect()
                }
            }
        }

        val walletStateJob = lifecycleScope.launch {
            walletSession.state.collect { s ->
                when (s) {
                    SessionState.Disconnected -> {
                        connectWalletBtn.text = "Connect Wallet"
                        connectWalletBtn.isEnabled = true
                        walletStatusLine.text = "Not connected"
                    }
                    SessionState.Connecting -> {
                        connectWalletBtn.text = "Connecting…"
                        connectWalletBtn.isEnabled = false
                        walletStatusLine.text = "Waiting for wallet…"
                    }
                    is SessionState.Connected -> {
                        val short = "${s.address.take(6)}…${s.address.takeLast(4)}"
                        connectWalletBtn.text = "Disconnect ($short)"
                        connectWalletBtn.isEnabled = true
                        walletStatusLine.text = s.chainId
                    }
                    is SessionState.Error -> {
                        connectWalletBtn.text = "Connect Wallet"
                        connectWalletBtn.isEnabled = true
                        walletStatusLine.text = "Error: ${s.reason}"
                    }
                }
            }
        }

        view.findViewById<View>(R.id.etchHistoryBtn).setOnClickListener {
            hapticTick()
            dialog.dismiss()
            showEtchHistory(
                activity = this@MainActivity,
                etchHistory = etchHistory,
                walletSession = walletSession,
                chainmarkController = chainmarkController,
                lifecycleScope = lifecycleScope,
                onCopy = ::copyToClipboard,
                onShowStatus = ::showStatus,
                onFetchPublic = { addr ->
                    binding.addressInput.setText(addr)
                    retrievePaste()
                },
                onFetchPrivate = ::retrievePrivateEtch,
            )
        }

        view.findViewById<View>(R.id.privateEtchesBtn).setOnClickListener {
            hapticTick()
            dialog.dismiss()
            openPrivateEtches()
        }

        view.findViewById<View>(R.id.chainmarkBtn).setOnClickListener {
            hapticTick()
            dialog.dismiss()
            showChainmarkScreen()
        }

        view.findViewById<View>(R.id.viewTermsBtn).setOnClickListener {
            hapticTick()
            showTermsReadOnlyDialog()
        }

        dialog.setOnDismissListener { walletStateJob.cancel() }

        view.findViewById<View>(R.id.settingsCancelBtn).setOnClickListener {
            dialog.dismiss()
        }

        view.findViewById<View>(R.id.settingsSaveBtn).setOnClickListener {
            hapticTick()
            prefs.edit()
                .putString("bootstrap_peers", peersInput.text.toString().trim())
                .apply()

            dialog.dismiss()

            binding.pasteButton.isEnabled = false
            binding.retrieveButton.isEnabled = false
            binding.resultCard.visibility = View.GONE
            connectToNetwork()
        }

        dialog.show()
    }

    // ── Private Etches Screen ─────────────────────────────────────

    private fun openPrivateEtches() {
        val authenticators = BiometricManager.Authenticators.BIOMETRIC_WEAK or
            BiometricManager.Authenticators.DEVICE_CREDENTIAL
        val canAuth = BiometricManager.from(this).canAuthenticate(authenticators)

        if (canAuth == BiometricManager.BIOMETRIC_SUCCESS) {
            val executor = ContextCompat.getMainExecutor(this)
            val prompt = BiometricPrompt(this, executor, object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    showPrivateEtchesScreen()
                }
                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    if (errorCode != BiometricPrompt.ERROR_USER_CANCELED &&
                        errorCode != BiometricPrompt.ERROR_NEGATIVE_BUTTON) {
                        showStatus("Authentication failed: $errString", isError = true)
                    }
                }
            })
            val info = BiometricPrompt.PromptInfo.Builder()
                .setTitle("Private etches")
                .setDescription("Authenticate to access your private etches")
                .setAllowedAuthenticators(authenticators)
                .build()
            prompt.authenticate(info)
        } else {
            showPrivateEtchesScreen()
        }
    }

    private fun showPrivateEtchesScreen() {
        val dialog = BottomSheetDialog(this, R.style.SheetDialog)
        val dp = resources.displayMetrics.density
        val pad = (24 * dp).toInt()

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
            setBackgroundColor(INK)
        }

        root.addView(TextView(this).apply {
            text = "Private Etches"
            setTextColor(BONE)
            textSize = 20f
            setTypeface(typeface, android.graphics.Typeface.BOLD)
            val mb = (4 * dp).toInt()
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply { bottomMargin = mb }
        })

        root.addView(TextView(this).apply {
            text = "These are stored securely on this device. Deleting an entry permanently removes access to that etch."
            setTextColor(ASH)
            textSize = 12f
            val mb = (16 * dp).toInt()
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply { bottomMargin = mb }
        })

        val privateEntries = privateDataStore.listAll()
        if (privateEntries.isEmpty()) {
            root.addView(TextView(this).apply {
                text = "No private etches"
                setTextColor(ASH)
                textSize = 13f
            })
        } else {
            val dateFormat = java.text.SimpleDateFormat("MMM d, yyyy  HH:mm", java.util.Locale.getDefault())
            val container = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }

            for (entry in privateEntries) {
                val row = LinearLayout(this).apply {
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

                row.addView(TextView(this).apply {
                    text = entry.title.ifEmpty { "Untitled" }
                    setTextColor(BONE)
                    textSize = 13f
                    maxLines = 1
                    ellipsize = android.text.TextUtils.TruncateAt.END
                })

                row.addView(TextView(this).apply {
                    text = dateFormat.format(java.util.Date(entry.timestampMs))
                    setTextColor(ASH)
                    textSize = 10f
                })

                row.setOnClickListener {
                    dialog.dismiss()
                    retrievePrivateEtch(entry.id)
                }

                row.setOnLongClickListener {
                    AlertDialog.Builder(this)
                        .setTitle("Delete private etch?")
                        .setMessage(
                            "${entry.title.ifEmpty { "Untitled" }}\n\n" +
                            "This will permanently remove the data map from this device. " +
                            "You will never be able to retrieve this etch again."
                        )
                        .setPositiveButton("Delete permanently") { _, _ ->
                            privateDataStore.remove(entry.id)
                            container.removeView(row)
                            if (container.childCount == 0) dialog.dismiss()
                        }
                        .setNegativeButton("Cancel", null)
                        .show()
                    true
                }

                container.addView(row)
            }
            root.addView(container)
        }

        // Backup button — only show if there are entries
        if (privateEntries.isNotEmpty()) {
            val backupBtn = com.google.android.material.button.MaterialButton(this).apply {
                text = "Backup to network"
                textSize = 13f
                isAllCaps = false
                val mt = (16 * dp).toInt()
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                ).apply { topMargin = mt }
                setOnClickListener {
                    dialog.dismiss()
                    promptBackupPassword(privateEntries.size)
                }
            }
            root.addView(backupBtn)
        }

        val scroll = androidx.core.widget.NestedScrollView(this).apply {
            addView(root)
        }
        dialog.setContentView(scroll)
        dialog.show()
    }

    // ── chain/it (chainmarks) ───────────────────────────────────────

    private fun showChainmarkScreen() {
        val dialog = BottomSheetDialog(this, R.style.SheetDialog)
        val dp = resources.displayMetrics.density
        val pad = (24 * dp).toInt()

        val container = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
            setBackgroundColor(INK)
        }

        fun heading(text: String, sizeSp: Float = 20f, bottomMarginDp: Int = 4) = TextView(this).apply {
            this.text = text
            setTextColor(BONE)
            textSize = sizeSp
            setTypeface(typeface, android.graphics.Typeface.BOLD)
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply { bottomMargin = (bottomMarginDp * dp).toInt() }
        }

        fun muted(text: String, bottomMarginDp: Int = 16) = TextView(this).apply {
            this.text = text
            setTextColor(ASH)
            textSize = 12f
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply { bottomMargin = (bottomMarginDp * dp).toInt() }
        }

        fun primaryButton(text: String, topMarginDp: Int = 8, onClick: () -> Unit) =
            com.google.android.material.button.MaterialButton(this).apply {
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
            com.google.android.material.button.MaterialButton(
                this,
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
                                showStatus("chain/it set up.")
                                render()
                            } catch (e: Exception) {
                                showStatus("Setup failed: ${e.message}", isError = true)
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
                        val list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
                        val df = java.text.SimpleDateFormat("MMM d, yyyy", java.util.Locale.getDefault())
                        for (e in visible) {
                            list.addView(chainmarkEntryRow(e, df, dialog) { render() })
                        }
                        container.addView(list)
                    }

                    container.addView(primaryButton("Sync chainmarks", topMarginDp = 16) {
                        lifecycleScope.launch {
                            try {
                                showStatus("Syncing chainmarks…")
                                chainmarkController.restoreFromChain(wallet)
                                showStatus("Chainmarks synced.")
                                render()
                            } catch (e: Exception) {
                                showStatus("Sync failed: ${e.message}", isError = true)
                            }
                        }
                    })

                    container.addView(outlinedButton("Add by address") {
                        promptAddByAddress { addr, title ->
                            lifecycleScope.launch {
                                try {
                                    val txHash = chainmarkController.addByAddress(chainId, wallet, addr, title, WireEntry.ACTION_ADD)
                                    showStatus("Synced: ${txHash.take(10)}…")
                                    render()
                                } catch (e: Exception) {
                                    showStatus("Add failed: ${e.message}", isError = true)
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
                        AlertDialog.Builder(this)
                            .setTitle("Forget chain/it?")
                            .setMessage(
                                "Removes the chainmark key from this device. Your on-chain entries remain " +
                                "permanent and you can restore by setting up again with the same wallet, " +
                                "or by pasting in a backup of the key."
                            )
                            .setPositiveButton("Forget") { _, _ ->
                                chainmarkController.forget(wallet)
                                showStatus("chain/it forgotten on this device.")
                                render()
                            }
                            .setNegativeButton("Cancel", null)
                            .show()
                    })
                }
            }
        }

        render()

        val scroll = androidx.core.widget.NestedScrollView(this).apply {
            addView(container)
        }
        dialog.setContentView(scroll)
        dialog.show()
    }

    private fun chainmarkEntryRow(
        entry: ChainmarkEntry,
        dateFormat: java.text.SimpleDateFormat,
        dialog: BottomSheetDialog,
        onChanged: () -> Unit,
    ): View {
        val dp = resources.displayMetrics.density
        val row = LinearLayout(this).apply {
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
        row.addView(TextView(this).apply {
            text = titleLine
            setTextColor(BONE)
            textSize = 13f
            maxLines = 1
            ellipsize = android.text.TextUtils.TruncateAt.END
        })
        row.addView(TextView(this).apply {
            text = "${entry.addr.take(10)}…  ${if (entry.ts > 0) dateFormat.format(java.util.Date(entry.ts * 1000)) else ""}"
            setTextColor(ASH)
            textSize = 10f
        })

        row.setOnClickListener {
            val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            cm.setPrimaryClip(ClipData.newPlainText("etch address", entry.addr))
            showStatus("Address copied")
        }

        row.setOnLongClickListener {
            val session = walletSession.state.value as? SessionState.Connected ?: return@setOnLongClickListener true
            AlertDialog.Builder(this)
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
                            showStatus("Hide queued.")
                            onChanged()
                        } catch (e: Exception) {
                            showStatus("Hide failed: ${e.message}", isError = true)
                        }
                    }
                }
                .setNegativeButton("Cancel", null)
                .show()
            true
        }
        return row
    }

    private fun backupChainmarkKeyWithBiometric(walletAddress: String) {
        val authenticators = BiometricManager.Authenticators.BIOMETRIC_WEAK or
            BiometricManager.Authenticators.DEVICE_CREDENTIAL
        val canAuth = BiometricManager.from(this).canAuthenticate(authenticators)
        if (canAuth != BiometricManager.BIOMETRIC_SUCCESS) {
            showChainmarkKeyBackup(walletAddress)
            return
        }
        val executor = ContextCompat.getMainExecutor(this)
        val prompt = BiometricPrompt(this, executor, object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                showChainmarkKeyBackup(walletAddress)
            }
            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                if (errorCode != BiometricPrompt.ERROR_USER_CANCELED &&
                    errorCode != BiometricPrompt.ERROR_NEGATIVE_BUTTON) {
                    showStatus("Authentication failed: $errString", isError = true)
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
            showStatus("No chainmark key to back up", isError = true)
            return
        }
        val hex = key.joinToString("") { "%02x".format(it.toInt() and 0xff) }
        val dp = resources.displayMetrics.density
        val pad = (16 * dp).toInt()
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
        }
        layout.addView(TextView(this).apply {
            text = "Save this in a password manager. Anyone with it can decrypt your chainmark entries on chain. The key is bound to this wallet only."
            setTextColor(ASH)
            textSize = 12f
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply { bottomMargin = (12 * dp).toInt() }
        })
        layout.addView(TextView(this).apply {
            text = hex
            setTextColor(BONE)
            textSize = 12f
            typeface = android.graphics.Typeface.MONOSPACE
            setTextIsSelectable(true)
        })
        AlertDialog.Builder(this)
            .setTitle("Chainmark key (hex)")
            .setView(layout)
            .setPositiveButton("Copy") { _, _ ->
                val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                cm.setPrimaryClip(ClipData.newPlainText("chainmark key", hex))
                showStatus("Chainmark key copied")
            }
            .setNegativeButton("Close", null)
            .show()
    }

    private fun promptRestoreChainmarkKey(walletAddress: String, onDone: () -> Unit) {
        val dp = resources.displayMetrics.density
        val pad = (16 * dp).toInt()
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
        }
        layout.addView(TextView(this).apply {
            text = "Paste the 64-character hex key from a previous backup. Replaces the current device's key."
            setTextColor(ASH)
            textSize = 12f
        })
        val input = EditText(this).apply {
            hint = "64-char hex"
            setSingleLine(true)
        }
        layout.addView(input)
        AlertDialog.Builder(this)
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
                    showStatus("Invalid key: ${e.message}", isError = true)
                    return@setPositiveButton
                }
                try {
                    chainmarkController.importKey(walletAddress, bytes)
                    showStatus("Chainmark key restored. Tap Sync chainmarks.")
                    onDone()
                } catch (e: Exception) {
                    showStatus("Restore failed: ${e.message}", isError = true)
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
            showStatus("No public etches in history.", isError = true)
            return
        }

        val dialog = BottomSheetDialog(this, R.style.SheetDialog)
        val dp = resources.displayMetrics.density
        val pad = (24 * dp).toInt()

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
            setBackgroundColor(INK)
        }

        root.addView(TextView(this).apply {
            text = "Add multiple from history"
            setTextColor(BONE)
            textSize = 20f
            setTypeface(typeface, android.graphics.Typeface.BOLD)
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply { bottomMargin = (4 * dp).toInt() }
        })
        root.addView(TextView(this).apply {
            text = "Tick the public etches to add. ~130 small entries fit in one batch tx; bigger lists split into multiple wallet prompts."
            setTextColor(ASH)
            textSize = 12f
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply { bottomMargin = (12 * dp).toInt() }
        })

        val countText = TextView(this).apply {
            text = "0 selected"
            setTextColor(ASH)
            textSize = 12f
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply { bottomMargin = (8 * dp).toInt() }
        }
        root.addView(countText)

        val checkboxes = mutableListOf<android.widget.CheckBox>()
        for (entry in historyEntries) {
            val cb = android.widget.CheckBox(this).apply {
                text = "${entry.title.ifEmpty { "Untitled" }}\n${entry.address.take(10)}…"
                setTextColor(BONE)
                isChecked = false
            }
            checkboxes += cb
            root.addView(cb)
        }

        val actionRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply { topMargin = (16 * dp).toInt() }
        }
        val cancelBtn = com.google.android.material.button.MaterialButton(
            this, null, com.google.android.material.R.attr.materialButtonOutlinedStyle,
        ).apply {
            text = "Cancel"
            isAllCaps = false
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply {
                marginEnd = (8 * dp).toInt()
            }
            setOnClickListener { dialog.dismiss() }
        }
        val addBtn = com.google.android.material.button.MaterialButton(this).apply {
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
                    showStatus("Sending ${selected.size} entries…")
                    val txHashes = chainmarkController.addMultiple(chainId, walletAddress, selected, WireEntry.ACTION_ADD)
                    val plural = if (txHashes.size > 1) "${txHashes.size} txs" else "1 tx"
                    showStatus("Synced ${selected.size} entries in $plural")
                    onDone()
                } catch (e: Exception) {
                    showStatus("Bulk add failed: ${e.message}", isError = true)
                }
            }
        }

        val scroll = androidx.core.widget.NestedScrollView(this).apply { addView(root) }
        dialog.setContentView(scroll)
        dialog.show()
    }

    // Parses a pasted, line-separated list. Each non-empty line must start with a
    // 64-char hex address; everything after the first whitespace is the optional title.
    // Returns (validEntries, lineNumbersThatFailed).
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

    private fun bulkAddByAddressDialog(
        chainId: String,
        walletAddress: String,
        onDone: () -> Unit,
    ) {
        val dp = resources.displayMetrics.density
        val pad = (16 * dp).toInt()
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
        }
        layout.addView(TextView(this).apply {
            text = "Paste 64-char etch addresses, one per line. Optional: add a space and a title after each address."
            setTextColor(ASH)
            textSize = 12f
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply { bottomMargin = (8 * dp).toInt() }
        })
        val input = EditText(this).apply {
            hint = "abcdef…  optional title\n0x1234…  another title\n…"
            inputType = android.text.InputType.TYPE_CLASS_TEXT or
                android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE
            setSingleLine(false)
            minLines = 6
            gravity = android.view.Gravity.TOP or android.view.Gravity.START
        }
        layout.addView(input)

        AlertDialog.Builder(this)
            .setTitle("Add multiple by address")
            .setView(layout)
            .setPositiveButton("Add") { _, _ ->
                val (entries, badLines) = parseAddressList(input.text.toString())
                if (entries.isEmpty()) {
                    showStatus("No valid addresses found", isError = true)
                    return@setPositiveButton
                }
                lifecycleScope.launch {
                    try {
                        showStatus("Adding ${entries.size}…")
                        val txHashes = chainmarkController.addMultiple(
                            chainId, walletAddress, entries, WireEntry.ACTION_ADD,
                        )
                        val plural = if (txHashes.size > 1) "${txHashes.size} txs" else "1 tx"
                        val skip = if (badLines.isNotEmpty()) " (skipped ${badLines.size} invalid line${if (badLines.size > 1) "s" else ""})" else ""
                        showStatus("Added ${entries.size} in $plural$skip")
                        onDone()
                    } catch (e: Exception) {
                        showStatus("Bulk add failed: ${e.message}", isError = true)
                    }
                }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun promptAddByAddress(onSubmit: (String, String) -> Unit) {
        val dp = resources.displayMetrics.density
        val pad = (16 * dp).toInt()
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
        }
        val addrInput = EditText(this).apply {
            hint = "64-character hex address"
            setSingleLine(true)
        }
        val titleInput = EditText(this).apply {
            hint = "Title (optional)"
            setSingleLine(true)
        }
        layout.addView(addrInput)
        layout.addView(titleInput)
        AlertDialog.Builder(this)
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

    // ── Backup / Restore ──────────────────────────────────────────

    // One backup passphrase per wallet, cached in EncryptedSharedPreferences.
    // The user still has the passphrase on paper / in a password manager —
    // this is a convenience cache so they don't re-pick a fresh passphrase
    // for every backup. EncryptedSharedPreferences is Keystore-backed, so
    // the on-disk bytes are AES-256 encrypted at rest. Wallet-scoped key
    // means swapping wallets resets the cache.
    private fun cachedBackupPassphraseKey(wallet: String): String =
        "backup_passphrase:${wallet.lowercase()}"

    private fun hasCachedBackupPassphrase(wallet: String): Boolean =
        encryptedPrefs.contains(cachedBackupPassphraseKey(wallet))

    private fun loadCachedBackupPassphrase(wallet: String): String? =
        encryptedPrefs.getString(cachedBackupPassphraseKey(wallet), null)

    private fun saveCachedBackupPassphrase(wallet: String, passphrase: String) {
        encryptedPrefs.edit().putString(cachedBackupPassphraseKey(wallet), passphrase).apply()
    }

    private fun clearCachedBackupPassphrase(wallet: String) {
        encryptedPrefs.edit().remove(cachedBackupPassphraseKey(wallet)).apply()
    }

    private fun currentWalletAddress(): String? {
        val s = walletSession.state.value
        return if (s is SessionState.Connected) s.address else null
    }

    private fun promptBackupPassword(entryCount: Int) {
        val wallet = currentWalletAddress()
        if (wallet != null && hasCachedBackupPassphrase(wallet)) {
            promptEtchBackupWithCachedPassphrase(wallet, entryCount)
            return
        }
        val dp = resources.displayMetrics.density
        val pad = (16 * dp).toInt()
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, 0)
        }

        layout.addView(TextView(this).apply {
            text = "Choose a passphrase. Reuse it across devices, or pick a fresh one each time. " +
                "You'll need it to restore."
            setTextColor(BONE)
        })

        val generateBtn = android.widget.Button(this).apply {
            text = "Generate strong passphrase"
            val mt = (12 * dp).toInt()
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply { topMargin = mt }
        }
        layout.addView(generateBtn)

        val passwordInput = EditText(this).apply {
            hint = "Password (or generated passphrase)"
            inputType = android.text.InputType.TYPE_CLASS_TEXT or
                android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
            setTextColor(BONE)
            val mt = (12 * dp).toInt()
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply { topMargin = mt }
        }
        layout.addView(passwordInput)

        val strengthLabel = TextView(this).apply {
            textSize = 12f
            val mt = (4 * dp).toInt()
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply { topMargin = mt }
        }
        layout.addView(strengthLabel)
        passwordInput.addTextChangedListener { applyStrength(strengthLabel, it?.toString().orEmpty()) }

        val confirmInput = EditText(this).apply {
            hint = "Confirm password"
            inputType = android.text.InputType.TYPE_CLASS_TEXT or
                android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
            setTextColor(BONE)
            val mt = (8 * dp).toInt()
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply { topMargin = mt }
        }
        layout.addView(confirmInput)

        // Reveal panel — only added once a passphrase is generated.
        val revealLabel = TextView(this).apply {
            text = ""
            setTextColor(COPPER_BRIGHT)
            textSize = 12f
            val mt = (12 * dp).toInt()
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply { topMargin = mt }
            visibility = View.GONE
        }
        val revealText = TextView(this).apply {
            text = ""
            setTextColor(BONE)
            textSize = 14f
            typeface = android.graphics.Typeface.MONOSPACE
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
        val revealHint = TextView(this).apply {
            text = "Write this down — there is no recovery if lost."
            setTextColor(ASH)
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
            passwordInput.inputType = android.text.InputType.TYPE_CLASS_TEXT
            confirmInput.inputType = android.text.InputType.TYPE_CLASS_TEXT
            passwordInput.setText(phrase)
            confirmInput.setText(phrase)
            revealLabel.text = "Generated passphrase — write it down before you tap Encrypt"
            revealText.text = phrase
            revealLabel.visibility = View.VISIBLE
            revealText.visibility = View.VISIBLE
            revealHint.visibility = View.VISIBLE
            // Tap-to-copy on the displayed phrase.
            revealText.setOnClickListener {
                val cm = getSystemService(android.content.Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
                cm.setPrimaryClip(android.content.ClipData.newPlainText("etchit backup passphrase", phrase))
                Snackbar.make(binding.root, "Passphrase copied", Snackbar.LENGTH_SHORT).show()
            }
        }

        AlertDialog.Builder(this)
            .setTitle("Backup private etches")
            .setView(layout)
            .setPositiveButton("Encrypt") { _, _ ->
                val pw = passwordInput.text.toString()
                val confirm = confirmInput.text.toString()
                if (pw.length < MIN_BACKUP_PASSWORD_LEN) {
                    showStatus("Password must be at least $MIN_BACKUP_PASSWORD_LEN characters", isError = true)
                    return@setPositiveButton
                }
                if (pw != confirm) {
                    showStatus("Passwords don't match", isError = true)
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
            pw.length < MIN_BACKUP_PASSWORD_LEN ->
                "Weak — use at least $MIN_BACKUP_PASSWORD_LEN characters" to STATUS_RED
            pw.length >= 12 || classes >= 3 -> "Strong" to STATUS_GREEN
            else -> "OK — stronger with mixed character types" to COPPER_BRIGHT
        }
        label.text = text
        label.setTextColor(color)
    }

    private fun confirmAndEtchBackup(password: String, entryCount: Int) {
        val plaintext = privateDataStore.exportAll()
        val encrypted = BackupCrypto.encrypt(plaintext, password)
        val sizeStr = PasteUtils.formatSize(encrypted.size)

        AlertDialog.Builder(this)
            .setTitle("Backup ready")
            .setMessage(
                "$sizeStr encrypted \u2022 $entryCount private etch${if (entryCount > 1) "es" else ""}\n\n" +
                "Etch this backup to the network? It will cost a small amount of ANT. " +
                "Anyone can fetch it but only your password can decrypt it."
            )
            .setPositiveButton("Etch backup") { _, _ ->
                etchBackupData(encrypted, password)
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    // Pre-flight dialog when the wallet already has a cached backup passphrase.
    // Skips the password entry form and goes straight to encrypt + etch using
    // the cached value. Inline links offer "show" and "use a different one"
    // for the rare cases where the user wants to verify or rotate.
    private fun promptEtchBackupWithCachedPassphrase(wallet: String, entryCount: Int) {
        val cached = loadCachedBackupPassphrase(wallet)
        if (cached == null) {
            // Cache lookup failed \u2014 fall back to normal flow.
            clearCachedBackupPassphrase(wallet)
            promptBackupPassword(entryCount)
            return
        }
        val dp = resources.displayMetrics.density
        val pad = (16 * dp).toInt()
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, 0)
        }
        layout.addView(TextView(this).apply {
            text = "Recovery passphrase set for this wallet. New backup will encrypt with the same passphrase you wrote down \u2014 no entry needed.\n\n" +
                "$entryCount private etch${if (entryCount > 1) "es" else ""} will be encrypted and etched to the network."
            setTextColor(BONE)
        })
        val linksRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            val mt = (16 * dp).toInt()
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply { topMargin = mt }
        }
        val showLink = TextView(this).apply {
            text = "Show passphrase"
            setTextColor(COPPER_BRIGHT)
            textSize = 13f
            paint.isUnderlineText = true
            val mr = (24 * dp).toInt()
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply { rightMargin = mr }
        }
        val differentLink = TextView(this).apply {
            text = "Use a different one"
            setTextColor(COPPER_BRIGHT)
            textSize = 13f
            paint.isUnderlineText = true
        }
        linksRow.addView(showLink)
        linksRow.addView(differentLink)
        layout.addView(linksRow)

        val dialog = AlertDialog.Builder(this)
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
        AlertDialog.Builder(this)
            .setTitle("Use a different passphrase?")
            .setMessage(
                "Your current cached passphrase will be removed from this device. " +
                "Existing backups encrypted with the old passphrase still decrypt with it (you'd need to remember both for those), " +
                "and your next new backup will use whatever passphrase you pick now."
            )
            .setPositiveButton("Use a different one") { _, _ ->
                clearCachedBackupPassphrase(wallet)
                promptBackupPassword(entryCount)
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun showCachedPassphraseDialog(passphrase: String, onDismiss: () -> Unit) {
        val dp = resources.displayMetrics.density
        val pad = (16 * dp).toInt()
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, 0)
        }
        layout.addView(TextView(this).apply {
            text = "Your recovery passphrase. Tap to copy. Anyone with this can decrypt your backup blobs."
            setTextColor(BONE)
            textSize = 13f
        })
        val phraseView = TextView(this).apply {
            text = passphrase
            setTextColor(BONE)
            typeface = android.graphics.Typeface.MONOSPACE
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
            val cm = getSystemService(android.content.Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
            cm.setPrimaryClip(android.content.ClipData.newPlainText("etchit backup passphrase", passphrase))
            Snackbar.make(binding.root, "Passphrase copied", Snackbar.LENGTH_SHORT).show()
        }
        layout.addView(phraseView)
        AlertDialog.Builder(this)
            .setTitle("Recovery passphrase")
            .setView(layout)
            .setPositiveButton("Done") { _, _ -> onDismiss() }
            .setOnCancelListener { onDismiss() }
            .show()
    }

    private fun etchBackupData(data: ByteArray, passphrase: String) {
        if (!walletSession.isConnected) {
            showStatus("Wallet required to etch backup", isError = true)
            return
        }

        binding.createSection.visibility = View.GONE
        binding.fetchDivider.visibility = View.GONE
        binding.fetchSection.visibility = View.GONE
        binding.pasteLoading.visibility = View.VISIBLE
        binding.pasteLoadingText.text = "Etching backup...  tap to cancel"
        showStatus("Etching backup to network…")

        storeJob = lifecycleScope.launch {
            opHelper.start("Starting…")
            try {
                val signer = EtchSigner(
                    nativeClient = nativeClient!!,
                    walletSession = walletSession,
                    walletSigner = (application as EtchitApplication).walletSigner,
                    evmRpc = EvmRpc(BuildConfig.RPC_URL),
                )

                val result = withContext(Dispatchers.IO) {
                    signer.etch(
                        data = data,
                        costPrompt = { totalAtto, dataSize, needsApproval ->
                            withContext(Dispatchers.Main) {
                                promptEtchCost(totalAtto, dataSize, needsApproval)
                            }
                        },
                        onProgress = { phase ->
                            val text = when (phase) {
                                EtchSigner.Progress.CollectingQuotes -> "Collecting quotes…"
                                EtchSigner.Progress.QuotesReady -> "Quotes ready — review cost"
                                EtchSigner.Progress.SwitchingChain -> "Switching wallet network…"
                                EtchSigner.Progress.CheckingAllowance -> "Checking ANT allowance…"
                                EtchSigner.Progress.ApprovingToken -> "Approving ANT spending…"
                                is EtchSigner.Progress.WaitingForApprove ->
                                    "Waiting for approve confirmation…"
                                EtchSigner.Progress.SigningPayment -> "Signing payment…"
                                is EtchSigner.Progress.WaitingForPayment ->
                                    "Waiting for payment confirmation…"
                                is EtchSigner.Progress.PaidAwaitingFinalize ->
                                    "Payment confirmed — storing backup…"
                                EtchSigner.Progress.FinalizingUpload -> "Finalizing backup…"
                            }
                            lifecycleScope.launch(Dispatchers.Main) {
                                showStatus(text)
                                opHelper.updateProgress(this@MainActivity, text)
                            }
                            if (phase is EtchSigner.Progress.ApprovingToken ||
                                phase is EtchSigner.Progress.SigningPayment) {
                                opHelper.notifyApprovalNeeded()
                            }
                        },
                    )
                }

                if (result == null) {
                    showStatus("Cancelled")
                    return@launch
                }

                when (result) {
                    is EtchSigner.EtchResult.Public -> {
                        resultCard.show("Backup", result.address, "")
                        binding.resultContent.text =
                            "Your private etches are backed up.\n\n" +
                            "Save this address — with your password it's your recovery key on any device."
                        showStatus("Backup etched \u2022 ${PasteUtils.formatSize(data.size)}")
                        etchHistory.add(result.address, "Backup")
                        // Cache the passphrase under this wallet so future backups
                        // reuse it silently. Idempotent — overwrites with the same
                        // value if the user is re-using their cached passphrase.
                        currentWalletAddress()?.let { saveCachedBackupPassphrase(it, passphrase) }
                    }
                    is EtchSigner.EtchResult.Private -> {
                        // Shouldn't happen — backups are always public
                        showStatus("Backup failed: unexpected private result", isError = true)
                    }
                }
            } catch (e: CancellationException) {
                showStatus("Cancelled")
                throw e
            } catch (e: Exception) {
                Log.e("ant-paste", "backup etch failed (${e.javaClass.simpleName}): ${e.message}", e)
                showStatus("Backup failed: ${e.shortMessage()}", isError = true)
            } finally {
                opHelper.finish()
                binding.pasteLoading.visibility = View.GONE
                binding.pasteLoadingText.text = "Etching...  tap to cancel"
                binding.createSection.visibility = View.VISIBLE
                binding.fetchDivider.visibility = View.VISIBLE
                binding.fetchSection.visibility = View.VISIBLE
                storeJob = null
            }
        }
    }

    private fun promptRestoreBackup(encryptedData: ByteArray) {
        val dp = resources.displayMetrics.density
        val pad = (20 * dp).toInt()
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, 0)
        }

        layout.addView(TextView(this).apply {
            text = "This is an encrypted etchit backup. Enter the 6-word recovery passphrase to restore your private etches."
            setTextColor(BONE)
        })

        // ── 3×2 grid of word boxes ──
        val gridWrap = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply { topMargin = (20 * dp).toInt() }
        }
        layout.addView(gridWrap)

        val boxes = mutableListOf<EditText>()
        repeat(2) { rowIdx ->
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = android.view.Gravity.CENTER_VERTICAL
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                ).apply { if (rowIdx > 0) topMargin = (10 * dp).toInt() }
            }
            repeat(3) { colIdx ->
                val idx = rowIdx * 3 + colIdx
                if (colIdx > 0) {
                    row.addView(TextView(this).apply {
                        text = "—"
                        setTextColor(ASH)
                        textSize = 14f
                        val mh = (6 * dp).toInt()
                        setPadding(mh, 0, mh, 0)
                    })
                }
                val box = EditText(this).apply {
                    hint = "${idx + 1}"
                    setTextColor(BONE)
                    setHintTextColor(ASH)
                    textSize = 14f
                    typeface = android.graphics.Typeface.MONOSPACE
                    setPadding((10 * dp).toInt(), (10 * dp).toInt(), (10 * dp).toInt(), (10 * dp).toInt())
                    inputType = android.text.InputType.TYPE_CLASS_TEXT or
                        android.text.InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
                    isSingleLine = true
                    imeOptions = if (idx == 5) android.view.inputmethod.EditorInfo.IME_ACTION_DONE
                                 else android.view.inputmethod.EditorInfo.IME_ACTION_NEXT
                    layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                }
                row.addView(box)
                boxes += box
            }
            gridWrap.addView(row)
        }

        // Auto-advance on space/dash; backspace on empty → previous; paste of dashed phrase distributes across boxes.
        for ((idx, box) in boxes.withIndex()) {
            box.addTextChangedListener(object : android.text.TextWatcher {
                private var skip = false
                override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
                override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
                override fun afterTextChanged(s: android.text.Editable?) {
                    if (skip || s == null) return
                    val text = s.toString()
                    // Paste of full dashed/spaced phrase
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
                            // Empty out beyond if the paste was exactly to the end
                            val nextEmpty = (idx + parts.size).coerceAtMost(boxes.size - 1)
                            boxes[nextEmpty].requestFocus()
                            boxes[nextEmpty].setSelection(boxes[nextEmpty].text.length)
                            skip = false
                            return
                        }
                        // Single-word followed by separator → advance
                        skip = true
                        s.replace(0, s.length, parts.firstOrNull().orEmpty().lowercase())
                        skip = false
                        if (idx < boxes.size - 1) boxes[idx + 1].requestFocus()
                    }
                }
            })
            box.setOnKeyListener { _, keyCode, event ->
                if (event.action == android.view.KeyEvent.ACTION_DOWN &&
                    keyCode == android.view.KeyEvent.KEYCODE_DEL &&
                    box.text.isEmpty() && idx > 0) {
                    boxes[idx - 1].requestFocus()
                    boxes[idx - 1].setSelection(boxes[idx - 1].text.length)
                    return@setOnKeyListener true
                }
                false
            }
        }

        // ── Custom password fallback (hidden by default) ──
        val customInput = EditText(this).apply {
            hint = "Custom password"
            inputType = android.text.InputType.TYPE_CLASS_TEXT or
                android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
            setTextColor(BONE)
            setHintTextColor(ASH)
            visibility = View.GONE
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply { topMargin = (20 * dp).toInt() }
        }
        layout.addView(customInput)

        var customMode = false
        val toggleLink = TextView(this).apply {
            text = "Use a custom password instead"
            setTextColor(0xFFc9732b.toInt())
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

        AlertDialog.Builder(this)
            .setTitle("Restore backup")
            .setView(layout)
            .setPositiveButton("Restore") { _, _ ->
                val pw = if (customMode) {
                    customInput.text.toString()
                } else {
                    boxes.joinToString("-") { it.text.toString().trim().lowercase() }
                }
                val decrypted = BackupCrypto.decrypt(encryptedData, pw)
                if (decrypted == null) {
                    showStatus("Wrong password or corrupted backup", isError = true)
                    return@setPositiveButton
                }
                val imported = privateDataStore.importAll(decrypted)
                if (imported > 0) {
                    showStatus("Restored $imported private etch${if (imported > 1) "es" else ""}")
                    Snackbar.make(binding.root, "Restored $imported private etch${if (imported > 1) "es" else ""}", Snackbar.LENGTH_LONG)
                        .setBackgroundTint(INK_3)
                        .setTextColor(STATUS_GREEN)
                        .show()
                } else {
                    showStatus("All etches already on this device")
                }
                // Cache the restore passphrase under this wallet so future
                // backups on this device automatically reuse it. Symmetric with
                // the backup-side caching, and avoids forcing a second
                // passphrase entry on a fresh device.
                currentWalletAddress()?.let { saveCachedBackupPassphrase(it, pw) }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    // ── Private Etch Retrieval ──────────────────────────────────────

    private var privateRetrieveJob: Job? = null

    private fun retrievePrivateEtch(dataMapId: String) {
        val authenticators = BiometricManager.Authenticators.BIOMETRIC_WEAK or
            BiometricManager.Authenticators.DEVICE_CREDENTIAL
        val canAuth = BiometricManager.from(this).canAuthenticate(authenticators)

        if (canAuth == BiometricManager.BIOMETRIC_SUCCESS) {
            promptBiometricThenRetrieve(dataMapId, authenticators)
        } else {
            Log.w("ant-paste", "No device credential available, skipping biometric")
            doPrivateRetrieve(dataMapId)
        }
    }

    private fun promptBiometricThenRetrieve(dataMapId: String, authenticators: Int) {
        val executor = ContextCompat.getMainExecutor(this)
        val prompt = BiometricPrompt(this, executor, object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                doPrivateRetrieve(dataMapId)
            }
            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                if (errorCode != BiometricPrompt.ERROR_USER_CANCELED &&
                    errorCode != BiometricPrompt.ERROR_NEGATIVE_BUTTON) {
                    showStatus("Authentication failed: $errString", isError = true)
                }
            }
        })
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle("Access private etch")
            .setDescription("Authenticate to retrieve your private etch")
            .setAllowedAuthenticators(authenticators)
            .build()
        prompt.authenticate(info)
    }

    private fun doPrivateRetrieve(dataMapId: String) {
        val entry = privateDataStore.get(dataMapId)
        if (entry == null) {
            showStatus("Private etch not found", isError = true)
            return
        }

        // Hide everything except the spinner
        binding.createSection.visibility = View.GONE
        binding.fetchDivider.visibility = View.GONE
        binding.fetchSection.visibility = View.GONE
        binding.pasteLoading.visibility = View.VISIBLE
        binding.pasteLoadingText.text = "Fetching...  tap to cancel"
        showStatus("Fetching private etch…")

        privateRetrieveJob = lifecycleScope.launch {
            opHelper.start("Starting…")
            opHelper.updateProgress(this@MainActivity, "Fetching private etch…")
            try {
                val data = withContext(Dispatchers.IO) {
                    nativeClient!!.dataGetPrivate(entry.dataMapHex)
                }
                val raw = data.toString(Charsets.UTF_8)
                val (title, content) = parseEnvelope(raw)

                resultCard.show(
                    title = title.ifEmpty { "Retrieved" },
                    address = "Private \u2022 stored on device",
                    content = content,
                )
                binding.resultAddress.setTextColor(STATUS_GREEN)
                binding.copyAddressBtn.visibility = View.GONE
                binding.shareButton.visibility = View.GONE
                showStatus("Retrieved privately")
            } catch (e: CancellationException) {
                showStatus("Cancelled")
                throw e
            } catch (e: Exception) {
                Log.e("ant-paste", "private retrieve failed (${e.javaClass.simpleName}): ${e.message}", e)
                showStatus("Failed: ${e.shortMessage()}", isError = true)
            } finally {
                opHelper.finish()
                binding.pasteLoading.visibility = View.GONE
                binding.pasteLoadingText.text = "Etching...  tap to cancel"
                binding.createSection.visibility = View.VISIBLE
                binding.fetchDivider.visibility = View.VISIBLE
                binding.fetchSection.visibility = View.VISIBLE
                privateRetrieveJob = null
            }
        }
    }
    // ── Share ──────────────────────────────────────────────────────

    private fun shareResult() {
        val address = binding.resultAddress.text.toString()
        if (address.isBlank()) return

        val shareIntent = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_SUBJECT, "etchit: ${binding.resultTitle.text}")
            putExtra(Intent.EXTRA_TEXT, "Etched permanently on the Autonomi network:\n\n${binding.resultContent.text}\n\nAddress: $address")
        }
        startActivity(Intent.createChooser(shareIntent, "Share etch"))
    }

    // ── Helpers ────────────────────────────────────────────────────

    private fun buildEnvelope(content: String, title: String): String =
        PasteUtils.buildEnvelope(content, title)

    private fun parseEnvelope(raw: String): Pair<String, String> =
        PasteUtils.parseEnvelope(raw)

    // Bridge from FullScreenTextDialog's Save action to the SAF launcher
    // registered above. Stash text, kick off the document picker.
    private fun launchSaveText(suggestedName: String, content: String) {
        pendingTextToSave = content
        saveTextLauncher.launch(suggestedName)
    }
    private fun showStatus(message: String, isError: Boolean = false) {
        binding.statusMessage.text = message
        binding.statusMessage.setTextColor(
            if (isError) STATUS_RED
            else if (message == "etch it. fetch it.") ASH
            else STATUS_MUTED_ACTIVE
        )
    }

    private fun handleSwipeRefresh() {
        if (binding.pasteLoading.visibility == View.VISIBLE) {
            binding.swipeRefresh.isRefreshing = false
            return
        }
        binding.titleInput.text.clear()
        binding.contentInput.text.clear()
        binding.addressInput.text.clear()
        binding.resultCard.visibility = View.GONE
        showStatus("etch it. fetch it.")
        binding.swipeRefresh.isRefreshing = false
    }

    private fun handleAttachedTextFile(uri: Uri) {
        val (displayName, sizeBytes) = queryUriMetadata(uri)
        if (sizeBytes != null && sizeBytes > MAX_ATTACHMENT_BYTES) {
            Snackbar.make(binding.root, "File too large — max 20 MB", Snackbar.LENGTH_LONG).show()
            return
        }
        val bytes = try {
            contentResolver.openInputStream(uri)?.use { it.readBytes() }
        } catch (e: Exception) {
            Log.w("ant-paste", "attach: read failed", e)
            null
        }
        if (bytes == null) {
            Snackbar.make(binding.root, "Could not read file", Snackbar.LENGTH_LONG).show()
            return
        }
        if (bytes.size > MAX_ATTACHMENT_BYTES) {
            Snackbar.make(binding.root, "File too large — max 20 MB", Snackbar.LENGTH_LONG).show()
            return
        }
        val text = try {
            val decoder = Charsets.UTF_8.newDecoder()
            decoder.decode(java.nio.ByteBuffer.wrap(bytes)).toString()
        } catch (_: Exception) {
            Snackbar.make(binding.root, "File is not valid UTF-8 text", Snackbar.LENGTH_LONG).show()
            return
        }
        binding.contentInput.setText(text)
        if (binding.titleInput.text.isNullOrBlank() && !displayName.isNullOrBlank()) {
            binding.titleInput.setText(displayName)
        }
        Snackbar.make(binding.root, "Loaded ${displayName ?: "file"}", Snackbar.LENGTH_SHORT).show()
    }

    private fun queryUriMetadata(uri: Uri): Pair<String?, Long?> {
        var name: String? = null
        var size: Long? = null
        contentResolver.query(uri, null, null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                val nameIdx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                val sizeIdx = cursor.getColumnIndex(OpenableColumns.SIZE)
                if (nameIdx >= 0 && !cursor.isNull(nameIdx)) name = cursor.getString(nameIdx)
                if (sizeIdx >= 0 && !cursor.isNull(sizeIdx)) size = cursor.getLong(sizeIdx)
            }
        }
        return name to size
    }

    /** Start piping ProgressTail events into the status line. Idempotent. */
    private fun startProgressTail() {
        if (progressTailJob?.isActive == true) return
        progressTailJob = ProgressTail.events()
            .onEach { showStatus(it) }
            .launchIn(lifecycleScope)
    }

    private fun copyToClipboard(text: String, label: String) {
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText("etchit", text))
        hapticTick()
        Snackbar.make(binding.root, "$label copied", Snackbar.LENGTH_SHORT)
            .setBackgroundTint(INK_3)
            .setTextColor(COPPER)
            .show()
    }

    private fun formatSize(bytes: Int): String = PasteUtils.formatSize(bytes)

    private fun formatTokenBalance(atto: String): String {
        return try {
            val value = BigDecimal(atto).divide(BigDecimal.TEN.pow(18), 4, RoundingMode.HALF_UP)
            if (value.compareTo(BigDecimal.ZERO) == 0) "0"
            else value.stripTrailingZeros().toPlainString()
        } catch (_: Exception) {
            atto
        }
    }

}
