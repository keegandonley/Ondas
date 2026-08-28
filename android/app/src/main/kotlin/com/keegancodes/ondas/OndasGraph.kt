package com.keegancodes.ondas

import android.content.Context
import android.util.Log
import com.keegancodes.ondas.chat.MlKitModel
import com.keegancodes.ondas.chat.OnDeviceModel
import com.keegancodes.ondas.data.ConversationRepository
import com.keegancodes.ondas.data.OndasDatabase
import com.keegancodes.ondas.kit.chat.GenerationSettingsStore
import com.keegancodes.ondas.kit.telemetry.HttpClientConfig
import com.keegancodes.ondas.kit.telemetry.KeyValueStore
import com.keegancodes.ondas.kit.telemetry.OtlpExporter
import com.keegancodes.ondas.kit.telemetry.SecretStore
import com.keegancodes.ondas.kit.telemetry.TelemetryService
import com.keegancodes.ondas.kit.telemetry.TelemetrySettingsStore
import com.keegancodes.ondas.telemetry.KeystoreSecretStore
import com.keegancodes.ondas.telemetry.SharedPreferencesKeyValueStore
import okhttp3.Call

private const val TAG = "Ondas"

/**
 * Manual dependency wiring.
 *
 * There is no DI framework on purpose: the graph is a handful of objects deep, the Swift app has
 * no third-party dependencies either, and both sibling Android ports settled the same way. A
 * container plus a `ViewModelProvider.Factory` covers it without a compiler plugin.
 */
public class OndasGraph(
    context: Context,
    /**
     * The transport. A parameter so a debug variant or a test can substitute one without the
     * networking module exposing a settable hook — OkHttp has no process-wide `URLProtocol`
     * registry the way Foundation does, so interception has to happen at the composition root.
     */
    calls: Call.Factory = HttpClientConfig.shared,
) {
    private val app: Context = context.applicationContext

    public val database: OndasDatabase by lazy { OndasDatabase.create(app) }

    public val repository: ConversationRepository by lazy {
        ConversationRepository(
            database.conversations(),
            logError = { message, error -> Log.e(TAG, message, error) },
        )
    }

    public val preferences: KeyValueStore by lazy { SharedPreferencesKeyValueStore(app) }

    private val secrets: SecretStore by lazy {
        KeystoreSecretStore(app) { message, error -> Log.e(TAG, message, error) }
    }

    public val telemetrySettings: TelemetrySettingsStore by lazy {
        TelemetrySettingsStore(preferences, secrets)
    }

    public val generationSettings: GenerationSettingsStore by lazy {
        GenerationSettingsStore(preferences)
    }

    public val model: OnDeviceModel by lazy { MlKitModel() }

    public val telemetry: TelemetryService by lazy {
        TelemetryService(
            OtlpExporter(
                serviceVersion = BuildConfig.VERSION_NAME,
                callFactory = calls,
                onTransportFailure = { Log.d(TAG, "Telemetry POST failed") },
            ),
            // The REAL model name from the API, not a synthetic constant (approved 2026-08-27).
            // A supplier, so it is resolved at span time when the model can actually answer.
            modelName = ::modelName,
        )
    }

    @Volatile
    private var cachedModelName: String? = null

    /**
     * The model's own name, asked for once and cached.
     *
     * Resolved lazily rather than at construction because `getBaseModelName()` suspends and fails
     * while Nano is still downloadable — which is every device's first run. On failure the fallback
     * is used for that span only, and the next span tries again, so a span emitted before the
     * download completes does not permanently pin the label.
     */
    private suspend fun modelName(): String {
        cachedModelName?.let { return it }
        val resolved = runCatching { model.baseModelName() }.getOrNull() ?: return FALLBACK_MODEL_NAME
        cachedModelName = resolved
        return resolved
    }

    public companion object {
        public const val FALLBACK_MODEL_NAME: String = "google-on-device"

        /**
         * Tokens held back from the context window for the model's reply.
         *
         * DERIVED from measurement, not inherited (PORTING.md § A1). Swift's 1024 was tuned
         * against a ~4096-token window and Nano's is 8192, so the number could not simply carry
         * over. Measured on the Pixel 11: the compaction summariser condenses a 5,959-token
         * segment in one pass and fails at roughly 7,900 with error code 12, so the safe ceiling
         * is **>= 5,959 tokens**.
         *
         * The constraint is that the warning band must fire while compaction can still succeed:
         *
         *     WARNING_FRACTION * (tokenLimit - reserve)  <=  summariser ceiling
         *     0.8              * (8192       - 1024)     =   5,734  <=  5,959   ✓
         *
         * leaving roughly 4% headroom. The value lands back on 1024 — but it is now the output of
         * that inequality rather than a constant inherited from a different model's window, and
         * if either the window or the summariser ceiling moves it has to be re-derived, not
         * re-guessed. `TokenUsageTest` pins the inequality so a change to WARNING_FRACTION cannot
         * silently break it.
         */
        public const val RESPONSE_TOKEN_RESERVE: Int = 1024

        /** The measured one-pass ceiling above. Kept so the derivation is checkable in a test. */
        public const val MEASURED_SUMMARISER_CEILING_TOKENS: Int = 5_959

        /** Nano 4's context window, from `getTokenLimit()` on the Pixel 11. */
        public const val MEASURED_TOKEN_LIMIT: Int = 8_192
    }
}
