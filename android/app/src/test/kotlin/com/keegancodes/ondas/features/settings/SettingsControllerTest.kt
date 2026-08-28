package com.keegancodes.ondas.features.settings

import com.keegancodes.ondas.kit.chat.GenerationSettingsStore
import com.keegancodes.ondas.kit.chat.ResponseStyle
import com.keegancodes.ondas.kit.telemetry.KeyValueStore
import com.keegancodes.ondas.kit.telemetry.OtlpExporter
import com.keegancodes.ondas.kit.telemetry.SecretStore
import com.keegancodes.ondas.kit.telemetry.TelemetryService
import com.keegancodes.ondas.kit.telemetry.TelemetrySettingsStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import okhttp3.Call
import okhttp3.Request
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.time.Instant

class SettingsControllerTest {

    private val preferences = MemoryStore()
    private val secrets = MemorySecrets()
    private val telemetrySettings = TelemetrySettingsStore(preferences, secrets)
    private val generationSettings = GenerationSettingsStore(preferences)

    /**
     * `Dispatchers.Unconfined` so `sendTest`'s `launch` runs inline. That is enough to observe a
     * result because a non-deliverable config short-circuits inside `OtlpExporter.deliver` before
     * any suspension — no thread, no clock, no network involved.
     */
    private val scope = CoroutineScope(Dispatchers.Unconfined)

    private fun controller() = SettingsController(
        telemetrySettings = telemetrySettings,
        generationSettings = generationSettings,
        telemetry = TelemetryService(
            OtlpExporter("1.0", NoNetwork),
            modelName = { "fake-model" },
        ),
        scope = scope,
        now = { Instant.fromEpochSeconds(1_700_000_000) },
    )

    // -- the test button's enablement ----------------------------------------------------------

    @Test
    fun `the test button is enabled only when the draft config is deliverable`() {
        val controller = controller()
        controller.load()
        assertFalse("nothing entered", controller.canSendTest)

        controller.updateEndpoint("https://example.com/api/otlp")
        controller.updateApiKey("otlp_key")
        assertFalse("telemetry still off", controller.canSendTest)

        controller.updateEnabled(true)
        assertTrue("enabled, https endpoint, key", controller.canSendTest)

        controller.updateApiKey("")
        assertFalse("no bearer key", controller.canSendTest)

        controller.updateApiKey("otlp_key")
        controller.updateEndpoint("http://example.com/api/otlp")
        assertFalse("plaintext endpoint", controller.canSendTest)
    }

    // -- the endpoint footer -------------------------------------------------------------------

    @Test
    fun `a plaintext or malformed endpoint is invalid, and an empty one is not`() {
        val controller = controller()
        controller.load()
        assertFalse("empty is not an error", controller.hasInvalidEndpoint)

        controller.updateEndpoint("http://example.com/api/otlp")
        assertTrue("plaintext HTTP is rejected", controller.hasInvalidEndpoint)

        controller.updateEndpoint("not a url")
        assertTrue(controller.hasInvalidEndpoint)

        controller.updateEndpoint("https://example.com/api/otlp")
        assertFalse(controller.hasInvalidEndpoint)
    }

    // -- the stale test result -----------------------------------------------------------------

    @Test
    fun `a prior test result is cleared when the endpoint or the key changes`() {
        val controller = controller()
        controller.load()
        controller.updateEnabled(true)
        controller.updateEndpoint("http://example.com/api/otlp")
        controller.updateApiKey("otlp_key")

        controller.sendTest()
        assertEquals(TestResult.FAILURE, controller.testResult)

        controller.updateEndpoint("https://example.com/api/otlp")
        assertNull("editing the endpoint invalidates the result", controller.testResult)

        controller.updateEndpoint("http://example.com/api/otlp")
        controller.sendTest()
        assertEquals(TestResult.FAILURE, controller.testResult)

        controller.updateApiKey("otlp_other")
        assertNull("editing the key invalidates the result", controller.testResult)
    }

    @Test
    fun `load clears a result left over from a previous visit`() {
        val controller = controller()
        controller.load()
        controller.updateEnabled(true)
        controller.updateEndpoint("http://example.com/api/otlp")
        controller.updateApiKey("otlp_key")
        controller.sendTest()
        assertEquals(TestResult.FAILURE, controller.testResult)

        controller.load()
        assertNull(controller.testResult)
    }

    // -- persistence ---------------------------------------------------------------------------

    @Test
    fun `save persists every field and the response style`() {
        val controller = controller()
        controller.load()
        controller.updateEnabled(true)
        controller.updateSendTranscripts(true)
        controller.updateEndpoint("https://example.com/api/otlp")
        controller.updateApiKey("otlp_secret")
        controller.updateResponseStyle(ResponseStyle.CREATIVE)

        controller.save()

        val saved = telemetrySettings.load()
        assertTrue(saved.isEnabled)
        assertTrue(saved.sendTranscripts)
        assertEquals("https://example.com/api/otlp", saved.endpoint)
        assertEquals("otlp_secret", saved.apiKey)
        assertEquals(ResponseStyle.CREATIVE, generationSettings.load())
    }

    @Test
    fun `load restores what save persisted`() {
        telemetrySettings.save(true, false, "https://example.com/api/otlp", "otlp_secret")
        generationSettings.save(ResponseStyle.PRECISE)

        val controller = controller()
        controller.load()

        assertTrue(controller.isEnabled)
        assertFalse(controller.sendTranscripts)
        assertEquals("https://example.com/api/otlp", controller.endpoint)
        assertEquals("otlp_secret", controller.apiKey)
        assertEquals(ResponseStyle.PRECISE, controller.responseStyle)
    }

    /** Fails loudly rather than reaching the network: no test here should get as far as a POST. */
    private object NoNetwork : Call.Factory {
        override fun newCall(request: Request): Call =
            throw AssertionError("a unit test must not open a connection")
    }

    private class MemoryStore : KeyValueStore {
        private val map = mutableMapOf<String, Any>()
        override fun string(key: String) = map[key] as? String
        override fun boolean(key: String) = map[key] as? Boolean ?: false
        override fun putString(key: String, value: String) { map[key] = value }
        override fun putBoolean(key: String, value: Boolean) { map[key] = value }
    }

    private class MemorySecrets : SecretStore {
        private val map = mutableMapOf<String, String>()
        override fun secret(account: String): String? = map[account]
        override fun setSecret(value: String?, account: String) {
            if (value.isNullOrEmpty()) map.remove(account) else map[account] = value
        }
    }
}
