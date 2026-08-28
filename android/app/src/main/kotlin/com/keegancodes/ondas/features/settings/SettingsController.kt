package com.keegancodes.ondas.features.settings

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.keegancodes.ondas.kit.chat.GenerationSettingsStore
import com.keegancodes.ondas.kit.chat.ResponseStyle
import com.keegancodes.ondas.kit.telemetry.TelemetryConfig
import com.keegancodes.ondas.kit.telemetry.TelemetryService
import com.keegancodes.ondas.kit.telemetry.TelemetrySettingsStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlin.time.Clock
import kotlin.time.Instant

/** Whether the last "Send test event" run was accepted by the collector. */
public enum class TestResult { SUCCESS, FAILURE }

/**
 * The editable state behind `SettingsView`.
 *
 * Holds the *unsaved* field values, exactly as Swift's `@State` properties do, and persists them
 * only on dismissal — see [save]. Splitting this out of the composable is what makes the two
 * behaviours that are easy to get wrong testable: that a stale test result is cleared the moment
 * the endpoint or key changes, and that the test button's enablement is derived from the draft
 * config rather than from the saved one.
 *
 * [scope] must outlive the sheet. `save()` is called while the sheet is leaving composition, so a
 * scope tied to the sheet would be cancelled before the telemetry service is told about the new
 * config — the counterpart of Swift's unstructured `Task { await …update(config) }`, which is not
 * bound to the view either.
 */
public class SettingsController(
    private val telemetrySettings: TelemetrySettingsStore,
    private val generationSettings: GenerationSettingsStore,
    private val telemetry: TelemetryService,
    private val scope: CoroutineScope,
    private val now: () -> Instant = { Clock.System.now() },
) {
    public var isEnabled: Boolean by mutableStateOf(false)
        private set
    public var sendTranscripts: Boolean by mutableStateOf(false)
        private set
    public var endpoint: String by mutableStateOf("")
        private set
    public var apiKey: String by mutableStateOf("")
        private set
    public var responseStyle: ResponseStyle by mutableStateOf(ResponseStyle.DEFAULT)
        private set
    public var testResult: TestResult? by mutableStateOf(null)
        private set
    public var isTesting: Boolean by mutableStateOf(false)
        private set

    /** The config assembled from the current (possibly unsaved) fields, for the test button. */
    public val draftConfig: TelemetryConfig
        get() = TelemetryConfig.fromFields(
            isEnabled = isEnabled,
            sendTranscripts = sendTranscripts,
            endpointField = endpoint,
            apiKeyField = apiKey,
        )

    /**
     * True when something was typed but it is not a usable HTTPS OTLP base URL, which swaps the
     * endpoint footer for the corrective wording. Note `fromFields` nulls a non-HTTPS endpoint, so
     * `http://…` lands here too — telemetry carries a bearer credential and optionally transcript
     * text, so plaintext is not merely discouraged, it is rejected.
     */
    public val hasInvalidEndpoint: Boolean
        get() = endpoint.trim().isNotEmpty() && draftConfig.endpoint == null

    /** Swift: `.disabled(isTesting || !draftConfig.isDeliverable)`. */
    public val canSendTest: Boolean
        get() = !isTesting && draftConfig.isDeliverable

    /** Swift's `.onAppear(perform: load)`. */
    public fun load() {
        val values = telemetrySettings.load()
        isEnabled = values.isEnabled
        sendTranscripts = values.sendTranscripts
        endpoint = values.endpoint
        apiKey = values.apiKey
        responseStyle = generationSettings.load()
        // A result from a previous visit says nothing about the values just loaded. Swift gets
        // this for free by building a fresh SettingsView per presentation; this controller is
        // longer-lived than the sheet, so it clears explicitly.
        testResult = null
        isTesting = false
    }

    public fun updateEnabled(value: Boolean) {
        isEnabled = value
    }

    public fun updateSendTranscripts(value: Boolean) {
        sendTranscripts = value
    }

    public fun updateResponseStyle(value: ResponseStyle) {
        responseStyle = value
    }

    /**
     * A prior test result is only valid for the endpoint/key it was run against, so it is dropped
     * the moment either changes — an edited (now-wrong) endpoint must not keep showing the
     * previous run's ✓. Swift does this with `.onChange(of:)` on both fields.
     */
    public fun updateEndpoint(value: String) {
        endpoint = value
        testResult = null
    }

    public fun updateApiKey(value: String) {
        apiKey = value
        testResult = null
    }

    /**
     * Persists everything and republishes the config to the telemetry service.
     *
     * Called from Swift's `.onDisappear`, i.e. on **any** dismissal — the Done button and an
     * interactive back gesture behave identically, so a freshly pasted key is never silently
     * discarded. That is a product decision, not an oversight; see [SettingsSheetContent], where
     * the single `DisposableEffect` makes both paths structurally the same call.
     */
    public fun save() {
        generationSettings.save(responseStyle)
        telemetrySettings.save(
            isEnabled = isEnabled,
            sendTranscripts = sendTranscripts,
            endpoint = endpoint,
            apiKey = apiKey,
        )
        val config = telemetrySettings.currentConfig()
        scope.launch { telemetry.update(config) }
    }

    /** Sends one synthetic span against the *draft* config, so an unsaved endpoint is testable. */
    public fun sendTest() {
        if (isTesting) return
        isTesting = true
        testResult = null
        val config = draftConfig
        scope.launch {
            val accepted = telemetry.sendTestEvent(config, now())
            isTesting = false
            testResult = if (accepted) TestResult.SUCCESS else TestResult.FAILURE
        }
    }
}
