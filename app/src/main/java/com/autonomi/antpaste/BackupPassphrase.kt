package com.autonomi.antpaste

import java.security.SecureRandom

/**
 * Diceware-style passphrase generator for backup encryption.
 * Produces 6 BIP-39 words by default = ~66 bits of entropy, well above
 * the EFF "valuable accounts" recommendation. With PBKDF2 at 600k
 * iterations on top, brute-force is infeasible against any non-state
 * adversary.
 *
 * Mirrors generatePassphrase() in the desktop client — same wordlist,
 * same separator, so a passphrase produced here decrypts cleanly on
 * desktop and vice versa.
 */
object BackupPassphrase {
    private val rng = SecureRandom()

    fun generate(numWords: Int = 6): String {
        val max = BIP39_WORDLIST.size
        val words = ArrayList<String>(numWords)
        // Rejection sample on a 16-bit window. 2048 IS a power of two so
        // the rejection branch never fires, but keep the discipline so
        // the function stays correct if the wordlist ever changes size.
        val reject = 65536 - (65536 % max)
        while (words.size < numWords) {
            val v = rng.nextInt(65536)
            if (v < reject) words += BIP39_WORDLIST[v % max]
        }
        return words.joinToString("-")
    }
}
