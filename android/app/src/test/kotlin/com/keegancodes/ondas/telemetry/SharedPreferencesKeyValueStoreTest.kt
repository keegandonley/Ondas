package com.keegancodes.ondas.telemetry

import androidx.test.core.app.ApplicationProvider
import com.keegancodes.ondas.kit.telemetry.TelemetrySettingsStore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * Covers the preferences half of the telemetry settings on a real (Robolectric) SharedPreferences.
 *
 * [KeystoreSecretStore] is NOT covered here: the Android Keystore is a hardware-backed provider
 * that Robolectric does not implement, so it can only be exercised on a device or emulator. That is
 * stated rather than papered over with a test that proves nothing.
 */
@RunWith(RobolectricTestRunner::class)
class SharedPreferencesKeyValueStoreTest {

    private val store = SharedPreferencesKeyValueStore(ApplicationProvider.getApplicationContext())

    @Test
    fun `absent keys read as empty and false, never null booleans`() {
        assertNull(store.string("telemetry.endpoint"))
        assertFalse(store.boolean("telemetry.enabled"))
    }

    @Test
    fun `values round trip`() {
        store.putString("telemetry.endpoint", "https://example.com/api/otlp")
        store.putBoolean("telemetry.enabled", true)
        assertEquals("https://example.com/api/otlp", store.string("telemetry.endpoint"))
        assertTrue(store.boolean("telemetry.enabled"))
    }

    /**
     * The settings store's real wiring: preferences for the non-secret fields, a secret store for
     * the key. Uses an in-memory secret store for the reason above.
     */
    @Test
    fun `settings store round trips against real SharedPreferences`() {
        val secrets = object : com.keegancodes.ondas.kit.telemetry.SecretStore {
            private val storage = mutableMapOf<String, String>()
            override fun secret(account: String) = storage[account]
            override fun setSecret(value: String?, account: String) {
                if (!value.isNullOrEmpty()) storage[account] = value else storage.remove(account)
            }
        }
        val settings = TelemetrySettingsStore(store, secrets)

        settings.save(true, true, "https://example.com/api/otlp", "otlp_key")

        val config = settings.currentConfig()
        assertTrue(config.isDeliverable)
        assertTrue(config.sendTranscripts)
        assertEquals("otlp_key", config.apiKey)
        assertEquals(
            "https://example.com/api/otlp",
            config.endpoint?.toString(),
        )
    }
}
