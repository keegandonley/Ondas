package com.keegancodes.ondas.features.settings

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
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
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import kotlin.time.Instant

@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "w411dp-h891dp")
class SettingsSheetTest {

    @get:Rule
    val compose = createComposeRule()

    private val preferences = MemoryStore()
    private val secrets = MemorySecrets()
    private val telemetrySettings = TelemetrySettingsStore(preferences, secrets)
    private val generationSettings = GenerationSettingsStore(preferences)
    private val scope = CoroutineScope(Dispatchers.Unconfined)

    private fun controller() = SettingsController(
        telemetrySettings = telemetrySettings,
        generationSettings = generationSettings,
        telemetry = TelemetryService(OtlpExporter("1.0", NoNetwork), modelName = { "fake-model" }),
        scope = scope,
        now = { Instant.fromEpochSeconds(1_700_000_000) },
    )

    /**
     * Renders the sheet's content under a switch the test can flip, which is how a dismissal is
     * expressed here: whatever tore the sheet down — Done, the scrim, the back gesture — the
     * content leaves composition, and that is the event save hangs off.
     */
    private fun renderDismissable(controller: SettingsController): () -> Unit {
        var visible by mutableStateOf(true)
        compose.setContent {
            MaterialTheme {
                if (visible) {
                    SettingsSheetContent(controller = controller, onDone = { visible = false })
                }
            }
        }
        return { visible = false }
    }

    // -- auto-save on ANY dismissal ------------------------------------------------------------

    /**
     * The deliberate product behaviour ported from Swift's `.onDisappear(perform: save)`: a
     * freshly pasted key survives a dismissal that never touched Done. Moving the save into the
     * Done handler fails this test and passes the next one, which is exactly the asymmetry this
     * pair exists to catch.
     */
    @Test
    fun `dismissing without pressing Done still saves`() {
        val controller = controller()
        val dismiss = renderDismissable(controller)

        compose.onNodeWithTag(API_KEY_FIELD_TAG).performScrollTo().performTextInput("otlp_fresh")
        compose.waitForIdle()
        assertEquals("not saved until dismissal", "", telemetrySettings.load().apiKey)

        dismiss()
        compose.waitForIdle()

        assertEquals("otlp_fresh", telemetrySettings.load().apiKey)
    }

    @Test
    fun `pressing Done saves the same way`() {
        val controller = controller()
        renderDismissable(controller)

        compose.onNodeWithTag(API_KEY_FIELD_TAG).performScrollTo().performTextInput("otlp_done")
        compose.onNodeWithText(DONE_ACTION).performScrollTo().performClick()
        compose.waitForIdle()

        assertEquals("otlp_done", telemetrySettings.load().apiKey)
    }

    @Test
    fun `the response style picked before dismissal is persisted`() {
        val controller = controller()
        val dismiss = renderDismissable(controller)

        compose.onNodeWithText(ResponseStyle.CREATIVE.title).performScrollTo().performClick()
        dismiss()
        compose.waitForIdle()

        assertEquals(ResponseStyle.CREATIVE, generationSettings.load())
    }

    // -- the test button -----------------------------------------------------------------------

    @Test
    fun `the send test button stays disabled until the draft config is deliverable`() {
        val controller = controller()
        renderDismissable(controller)

        compose.onNodeWithTag(SEND_TEST_BUTTON_TAG).performScrollTo().assertIsNotEnabled()

        compose.onNodeWithTag(ENDPOINT_FIELD_TAG).performScrollTo()
            .performTextInput("https://example.com/api/otlp")
        compose.onNodeWithTag(API_KEY_FIELD_TAG).performScrollTo().performTextInput("otlp_key")
        compose.onNodeWithTag(SEND_TEST_BUTTON_TAG).performScrollTo()
            .assertIsNotEnabled() // telemetry itself is still off

        compose.onNodeWithTag(toggleTag(TELEMETRY_LABEL)).performScrollTo().performClick()
        compose.onNodeWithTag(SEND_TEST_BUTTON_TAG).performScrollTo().assertIsEnabled()
    }

    // -- the endpoint footer -------------------------------------------------------------------

    @Test
    fun `a non-HTTPS endpoint swaps the footer for the corrective message`() {
        val controller = controller()
        renderDismissable(controller)

        compose.onNodeWithText(ENDPOINT_FOOTER).assertExists()
        compose.onNodeWithText(ENDPOINT_INVALID_FOOTER).assertDoesNotExist()

        compose.onNodeWithTag(ENDPOINT_FIELD_TAG).performScrollTo()
            .performTextInput("http://example.com/api/otlp")
        compose.waitForIdle()

        compose.onNodeWithText(ENDPOINT_INVALID_FOOTER).assertExists()
        compose.onNodeWithText(ENDPOINT_FOOTER).assertDoesNotExist()
    }

    // -- the transcript opt-in -----------------------------------------------------------------

    @Test
    fun `transcript capture cannot be turned on while telemetry is off`() {
        val controller = controller()
        renderDismissable(controller)

        compose.onNodeWithTag(toggleTag(TRANSCRIPTS_LABEL)).performScrollTo().assertIsNotEnabled()
        compose.onNodeWithTag(toggleTag(TELEMETRY_LABEL)).performScrollTo().performClick()
        compose.onNodeWithTag(toggleTag(TRANSCRIPTS_LABEL)).performScrollTo().assertIsEnabled()
    }

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
