package com.autonomi.antpaste.chainmark

import android.content.SharedPreferences
import com.autonomi.antpaste.wallet.WalletSigner

// Implements §4 of docs/chainmark-format-v1.md. Stores the derived AEAD key
// per-wallet in EncryptedSharedPreferences; never persists the raw signature.
// Re-deriving on a fresh device assumes the wallet uses RFC 6979 (§4.5).
class ChainmarkKeyManager(
    private val encryptedPrefs: SharedPreferences,
    private val walletSigner: WalletSigner,
) {

    fun hasCachedKey(walletAddress: String): Boolean =
        encryptedPrefs.contains(prefKey(walletAddress))

    fun getCachedKey(walletAddress: String): ByteArray? {
        val hex = encryptedPrefs.getString(prefKey(walletAddress), null) ?: return null
        return Hex.decode(hex)
    }

    suspend fun deriveAndCache(chainId: String, walletAddress: String): ByteArray {
        val sigHex = walletSigner.personalSign(chainId, walletAddress, SIGN_MESSAGE)
        return cacheFromSignature(walletAddress, Hex.decode(sigHex))
    }

    // Pure (no wallet/IO) — split out so unit tests can exercise key derivation
    // and persistence without an AppKit session.
    internal fun cacheFromSignature(walletAddress: String, signatureRSV: ByteArray): ByteArray {
        require(signatureRSV.size == 65) { "personal_sign signature must be 65 bytes (r||s||v), got ${signatureRSV.size}" }
        val ikm = signatureRSV.copyOfRange(0, 64)
        val key = ChainmarkCrypto.deriveKey(ikm)
        writeKey(walletAddress, key)
        return key
    }

    fun importKey(walletAddress: String, key: ByteArray) {
        require(key.size == ChainmarkCrypto.KEY_LEN) { "chainmark key must be ${ChainmarkCrypto.KEY_LEN} bytes" }
        writeKey(walletAddress, key)
    }

    fun forget(walletAddress: String) {
        encryptedPrefs.edit().remove(prefKey(walletAddress)).apply()
    }

    fun forgetAll() {
        val keys = encryptedPrefs.all.keys.filter { it.startsWith(KEY_PREFIX) }
        if (keys.isEmpty()) return
        encryptedPrefs.edit().apply { keys.forEach { remove(it) } }.apply()
    }

    private fun writeKey(walletAddress: String, key: ByteArray) {
        encryptedPrefs.edit().putString(prefKey(walletAddress), Hex.encode(key)).apply()
    }

    private fun prefKey(walletAddress: String) = KEY_PREFIX + walletAddress.lowercase()

    companion object {
        private const val KEY_PREFIX = "chainmark_key_v1_"

        // §4.1 — byte-exact sign message; SHA-256 = ab6f4ae2…cecab0; 131 bytes UTF-8.
        // Changing this string invalidates every existing chainmark on chain.
        const val SIGN_MESSAGE = "etchit chainmark v1\n\n" +
            "Sign this message to derive your chainmark key. " +
            "This signature does NOT authorize any transaction or transfer."
    }
}
