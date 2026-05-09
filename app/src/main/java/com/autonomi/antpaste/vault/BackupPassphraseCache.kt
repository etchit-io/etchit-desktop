package com.autonomi.antpaste.vault

import android.content.SharedPreferences

// One backup passphrase per wallet, cached in EncryptedSharedPreferences.
// The user still has the passphrase on paper / in a password manager —
// this is a convenience cache so they don't re-pick a fresh passphrase
// for every backup. EncryptedSharedPreferences is Keystore-backed, so
// the on-disk bytes are AES-256 encrypted at rest. Wallet-scoped key
// means swapping wallets resets the cache.
class BackupPassphraseCache(private val prefs: SharedPreferences) {

    fun has(wallet: String): Boolean = prefs.contains(keyFor(wallet))

    fun load(wallet: String): String? = prefs.getString(keyFor(wallet), null)

    fun save(wallet: String, passphrase: String) {
        prefs.edit().putString(keyFor(wallet), passphrase).apply()
    }

    fun clear(wallet: String) {
        prefs.edit().remove(keyFor(wallet)).apply()
    }

    private fun keyFor(wallet: String): String = "backup_passphrase:${wallet.lowercase()}"
}
