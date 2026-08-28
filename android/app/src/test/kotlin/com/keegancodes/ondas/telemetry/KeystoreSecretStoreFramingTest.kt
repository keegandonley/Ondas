package com.keegancodes.ondas.telemetry

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertThrows
import org.junit.Test

/**
 * Covers the IV framing in [KeystoreSecretStore] — the only part of that class that is logic rather
 * than platform calls, and the part a malformed stored value flows through.
 *
 * The Keystore itself has no coverage here and cannot: Robolectric does not implement the
 * `AndroidKeyStore` provider, so an encrypt/decrypt round-trip is device-verify-only. Stated
 * rather than faked with a test that would prove nothing.
 */
class KeystoreSecretStoreFramingTest {

    @Test
    fun `framing round trips`() {
        val iv = ByteArray(12) { it.toByte() }
        val ciphertext = ByteArray(40) { (it + 100).toByte() }

        val (decodedIv, decodedCiphertext) =
            KeystoreSecretStore.unframe(KeystoreSecretStore.frame(iv, ciphertext))

        assertArrayEquals(iv, decodedIv)
        assertArrayEquals(ciphertext, decodedCiphertext)
    }

    @Test
    fun `framing survives an IV length other than the usual twelve`() {
        // The whole point of length-prefixing instead of hard-coding 12.
        val iv = ByteArray(16) { 7 }
        val ciphertext = byteArrayOf(1, 2, 3)

        val (decodedIv, decodedCiphertext) =
            KeystoreSecretStore.unframe(KeystoreSecretStore.frame(iv, ciphertext))

        assertArrayEquals(iv, decodedIv)
        assertArrayEquals(ciphertext, decodedCiphertext)
    }

    @Test
    fun `malformed payloads are rejected rather than read out of bounds`() {
        // Each of these is a plausible corrupt or truncated stored value; none may index past the
        // end of the array. The caller turns the throw into a quarantine.
        assertThrows(IllegalArgumentException::class.java) {
            KeystoreSecretStore.unframe(ByteArray(0))
        }
        assertThrows(IllegalArgumentException::class.java) {
            KeystoreSecretStore.unframe(byteArrayOf(0, 1, 2)) // zero-length IV
        }
        assertThrows(IllegalArgumentException::class.java) {
            KeystoreSecretStore.unframe(byteArrayOf(99, 1, 2)) // IV longer than the payload
        }
        assertThrows(IllegalArgumentException::class.java) {
            // A length byte above 127 sign-extends to negative; it must be rejected, not used.
            KeystoreSecretStore.unframe(byteArrayOf(-1, 1, 2, 3))
        }
        assertThrows(IllegalArgumentException::class.java) {
            KeystoreSecretStore.unframe(byteArrayOf(2, 9, 9)) // no room left for ciphertext
        }
    }
}
