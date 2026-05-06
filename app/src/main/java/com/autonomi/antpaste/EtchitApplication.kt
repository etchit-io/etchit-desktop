package com.autonomi.antpaste

import android.app.Application
import android.system.Os
import android.util.Log
import com.autonomi.antpaste.wallet.WalletSession
import com.autonomi.antpaste.wallet.WalletSigner
import com.reown.android.Core
import com.reown.android.CoreClient
import com.reown.appkit.client.AppKit
import com.reown.appkit.client.Modal
import com.reown.appkit.presets.AppKitChainsPresets
import uniffi.ant_ffi.setupLogger

/**
 * Bootstraps Reown AppKit (WalletConnect v2) and owns the single
 * [WalletSession] instance that the rest of the app observes.
 *
 * If `REOWN_PROJECT_ID` is missing from `local.properties`, AppKit is
 * skipped — reads still work but wallet-connect is a no-op until the
 * key is provided. [walletSession] is still constructed so the UI can
 * observe a stable `Disconnected` state without null checks.
 *
 * Do not add synchronous work beyond what's strictly needed; the main
 * thread is blocked until `onCreate` returns.
 */
class EtchitApplication : Application() {

    lateinit var walletSession: WalletSession
        private set

    val walletSigner: WalletSigner = WalletSigner()

    override fun onCreate() {
        super.onCreate()

        // ant-core 0.2.3's `data_dir()` calls `home_dir().unwrap()` on Linux
        // when XDG_DATA_HOME is unset — Android sets neither HOME nor
        // XDG_DATA_HOME by default, so the unwrap panics with HomeDirNotFound
        // the first time anything in the FFI builds a Client. Point HOME at
        // the app-private data dir so the platform-derived `~/.local/share/ant`
        // resolves to a path we can actually write to. Must run before any
        // FFI call (logger init, Client.connect, etc.).
        Os.setenv("HOME", filesDir.absolutePath, true)

        setupLogger()

        val idPrefix = BuildConfig.REOWN_PROJECT_ID.take(8).ifEmpty { "<missing>" }
        Log.i(
            "ant-paste",
            "EtchitApplication.onCreate (reown=$idPrefix… chain=${BuildConfig.CHAIN_ID})"
        )

        if (BuildConfig.REOWN_PROJECT_ID.isBlank()) {
            Log.w(
                "ant-paste",
                "REOWN_PROJECT_ID missing from local.properties — AppKit disabled"
            )
            walletSession = WalletSession(walletSigner)
            return
        }

        val metadata = Core.Model.AppMetaData(
            name = "etchit",
            description = "Permanent decentralized pastebin on Autonomi",
            url = "https://etchit.io",
            icons = listOf("https://etchit.io/icon.png"),
            redirect = "etchit-wc://request",
        )

        CoreClient.initialize(
            application = this,
            projectId = BuildConfig.REOWN_PROJECT_ID,
            metaData = metadata,
        ) { error ->
            Log.e(
                "ant-paste",
                "CoreClient.initialize failed: ${error.throwable.message}",
                error.throwable,
            )
        }

        AppKit.initialize(Modal.Params.Init(core = CoreClient)) { error ->
            Log.e(
                "ant-paste",
                "AppKit.initialize failed: ${error.throwable.message}",
                error.throwable,
            )
        }

        // AppKit keeps any persisted session from a prior run;
        // WalletSession.init hydrates from AppKit.getAccount() on
        // construction. If a session is stale the relay fires
        // onSessionDelete or the next request fails with a clear error.
        walletSession = WalletSession(walletSigner)
        try {
            AppKit.setDelegate(walletSession)
            // Single-chain session — every major mobile wallet ships
            // Arbitrum One in its built-in network list, so the proposal
            // is accepted without manual network setup and the namespace
            // covers eth_sendTransaction.
            val arbitrumOne = AppKitChainsPresets.ethChains["42161"]
                ?: error("AppKit presets missing Arbitrum One")
            AppKit.setChains(listOf(arbitrumOne))
            Log.i(
                "ant-paste",
                "AppKit + CoreClient initialized, delegate set, chain=eip155:${BuildConfig.CHAIN_ID}"
            )
        } catch (e: IllegalStateException) {
            Log.e("ant-paste", "AppKit.setDelegate/setChains failed", e)
        }
    }
}
