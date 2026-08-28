package com.keegancodes.ondas.telemetry

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.keegancodes.ondas.kit.telemetry.SecretStore
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The telemetry bearer key, encrypted with a key held in the Android Keystore.
 *
 * Deliberately **not** `androidx.security:security-crypto` / `EncryptedSharedPreferences`: that
 * library is deprecated. This uses the Keystore directly, the same shape both sibling ports settled
 * on.
 *
 * The counterpart of Swift's `KeychainSecretStore`, and it lives in `:app` for the same reason that
 * one lives beside the app rather than in a shared layer — `:ondaskit` declares the [SecretStore]
 * interface and stays free of platform APIs.
 */
public class KeystoreSecretStore(
    context: Context,
    private val logError: (String, Throwable?) -> Unit = { _, _ -> },
) : SecretStore {

    private val preferences: SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

    override fun secret(account: String): String? {
        val stored = preferences.getString(account, null) ?: return null
        return try {
            decrypt(Base64.decode(stored, Base64.NO_WRAP))
        } catch (error: Exception) {
            // A secret that cannot be decrypted is a secret we do not have. The Keystore key is
            // dropped when the user adds or removes a device lock, so this is a normal condition
            // rather than an error to propagate. Quarantine it so we do not retry forever.
            logError("Telemetry key could not be decrypted; clearing it", error)
            preferences.edit().remove(account).apply()
            null
        }
    }

    override fun setSecret(value: String?, account: String) {
        // Empty or null clears the stored secret rather than storing a blank one, matching Swift.
        if (value.isNullOrEmpty()) {
            preferences.edit().remove(account).apply()
            return
        }
        try {
            val encoded = Base64.encodeToString(encrypt(value), Base64.NO_WRAP)
            preferences.edit().putString(account, encoded).apply()
        } catch (error: Exception) {
            // A silent failure here means the user's key evaporates on the next launch and
            // telemetry quietly stops. Swift logs the same condition for the same reason.
            logError("Telemetry key could not be stored", error)
        }
    }

    private fun encrypt(value: String): ByteArray {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        val ciphertext = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        return frame(cipher.iv, ciphertext)
    }

    private fun decrypt(payload: ByteArray): String {
        val (iv, ciphertext) = unframe(payload)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(TAG_BITS, iv))
        return String(cipher.doFinal(ciphertext), Charsets.UTF_8)
    }

    /**
     * Fetches the Keystore key, creating it on first use.
     *
     * Synchronised on a PROCESS-wide lock because the alias is process-wide. Without it two
     * concurrent first-use calls both observe "absent" and both generate under the same alias; the
     * second silently replaces the first, and anything already encrypted under the discarded key
     * becomes permanently undecryptable — which [secret] then quarantines, so the failure is a
     * silently deleted credential rather than a crash.
     *
     * Swift's Keychain path has no key-generation step at all, so this hazard is Android-only and
     * has no counterpart to port.
     */
    private fun secretKey(): SecretKey = synchronized(KEY_LOCK) {
        val keyStore = KeyStore.getInstance(PROVIDER).apply { load(null) }
        (keyStore.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let {
            return@synchronized it.secretKey
        }

        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER)
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                // The analogue of iOS's kSecAttrAccessibleAfterFirstUnlock. Telemetry is flushed
                // from ordinary app work that has no UI to prompt with, so requiring
                // authentication here would mean the key is simply unreadable at the moment it is
                // needed.
                .setUserAuthenticationRequired(false)
                .build(),
        )
        return generator.generateKey()
    }

    public companion object {
        /** Guards key creation. Process-wide because [KEY_ALIAS] is. */
        private val KEY_LOCK = Any()

        /**
         * Length-prefixes the IV rather than assuming 12 bytes, so a future provider emitting a
         * different IV or tag size can still read values written today without a migration.
         *
         * Internal and pure so the framing — the only part of this class with logic rather than
         * platform calls — is unit-testable. The Keystore itself is not: Robolectric does not
         * implement it, so encrypt/decrypt round-trips are device-verify-only.
         */
        internal fun frame(iv: ByteArray, ciphertext: ByteArray): ByteArray =
            byteArrayOf(iv.size.toByte()) + iv + ciphertext

        /** Inverse of [frame]. Throws on anything malformed; callers quarantine rather than retry. */
        internal fun unframe(payload: ByteArray): Pair<ByteArray, ByteArray> {
            require(payload.isNotEmpty()) { "empty payload" }
            // toInt() on a Byte sign-extends, so a length above 127 would arrive negative and the
            // range check below is what stops it being used as an index.
            val ivLength = payload[0].toInt()
            require(ivLength in 1..payload.size - 2) { "bad IV length: $ivLength" }
            return payload.copyOfRange(1, 1 + ivLength) to
                payload.copyOfRange(1 + ivLength, payload.size)
        }

        private const val PROVIDER = "AndroidKeyStore"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val TAG_BITS = 128
        private const val KEY_ALIAS = "ondas.telemetry-key.v1"

        /** Holds ciphertext only; the key itself never leaves the Keystore. */
        public const val PREFERENCES_NAME: String = "ondas.credentials"
    }
}
