package com.keegancodes.ondas.kit.telemetry

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/**
 * An immutable snapshot of the user's telemetry preferences.
 *
 * Telemetry is opt-in and off by default. When enabled it sends usage data only to the endpoint
 * the user chose.
 *
 * The endpoint is an OkHttp [HttpUrl] rather than a `java.net.URL`: it is the type the transport
 * needs anyway, it rejects malformed input by returning null the way Swift's `URL(string:)` does,
 * and it will not silently accept a string with spaces in it.
 */
public data class TelemetryConfig(
    public val isEnabled: Boolean,
    public val sendTranscripts: Boolean,
    public val endpoint: HttpUrl?,
    public val apiKey: String?,
) {
    /** Whether a span can actually be delivered — enabled, with a destination and a key. */
    public val isDeliverable: Boolean
        get() = isEnabled && isSecureEndpoint(endpoint) && !apiKey.isNullOrEmpty()

    public companion object {
        public val DISABLED: TelemetryConfig = TelemetryConfig(
            isEnabled = false,
            sendTranscripts = false,
            endpoint = null,
            apiKey = null,
        )

        /**
         * Telemetry carries a bearer credential and can optionally carry transcript text, so
         * delivery is deliberately limited to well-formed HTTPS endpoints.
         */
        public fun isSecureEndpoint(endpoint: HttpUrl?): Boolean {
            if (endpoint == null) return false
            return endpoint.scheme.lowercase() == "https" && endpoint.host.isNotEmpty()
        }

        /**
         * Builds a config from raw user-entered field values, normalising them the single way the
         * app does it (trim; blank means absent). Shared by the persisted settings and the Settings
         * screen's unsaved draft, so the test button exercises exactly what saving would produce.
         */
        public fun fromFields(
            isEnabled: Boolean,
            sendTranscripts: Boolean,
            endpointField: String,
            apiKeyField: String,
        ): TelemetryConfig {
            val trimmedEndpoint = endpointField.trim()
            val trimmedKey = apiKeyField.trim()
            val parsed = if (trimmedEndpoint.isEmpty()) null else trimmedEndpoint.toHttpUrlOrNull()
            return TelemetryConfig(
                isEnabled = isEnabled,
                sendTranscripts = sendTranscripts,
                endpoint = if (isSecureEndpoint(parsed)) parsed else null,
                apiKey = trimmedKey.ifEmpty { null },
            )
        }
    }
}

/**
 * A minimal secret store so the telemetry key can live in the Android Keystore in the app while
 * tests substitute an in-memory implementation.
 *
 * The interface lives here, in the platform-free module, and the Keystore-backed implementation
 * lives in `:app` — the same split Swift uses, where `KeychainSecretStore` sits beside the app and
 * not in a shared layer.
 */
public interface SecretStore {
    public fun secret(account: String): String?
    public fun setSecret(value: String?, account: String)
}

/** Non-secret preference storage. Backed by SharedPreferences in `:app`. */
public interface KeyValueStore {
    public fun string(key: String): String?
    public fun boolean(key: String): Boolean
    public fun putString(key: String, value: String)
    public fun putBoolean(key: String, value: Boolean)
}

/**
 * Loads and persists telemetry preferences: the on/off flag and endpoint in ordinary preference
 * storage, the bearer key in a [SecretStore] so the secret never lands in a plain preferences file.
 */
public class TelemetrySettingsStore(
    private val defaults: KeyValueStore,
    private val secrets: SecretStore,
) {
    /** The user-editable field values. */
    public data class Values(
        val isEnabled: Boolean,
        val sendTranscripts: Boolean,
        val endpoint: String,
        val apiKey: String,
    )

    public fun load(): Values = Values(
        isEnabled = defaults.boolean(KEY_ENABLED),
        sendTranscripts = defaults.boolean(KEY_SEND_TRANSCRIPTS),
        endpoint = defaults.string(KEY_ENDPOINT) ?: "",
        apiKey = secrets.secret(KEY_API_KEY_ACCOUNT) ?: "",
    )

    /** Persists the fields; a blank key clears the stored secret. */
    public fun save(
        isEnabled: Boolean,
        sendTranscripts: Boolean,
        endpoint: String,
        apiKey: String,
    ) {
        defaults.putBoolean(KEY_ENABLED, isEnabled)
        defaults.putBoolean(KEY_SEND_TRANSCRIPTS, sendTranscripts)
        defaults.putString(KEY_ENDPOINT, endpoint)
        secrets.setSecret(apiKey, KEY_API_KEY_ACCOUNT)
    }

    /** The immutable snapshot to hand to [TelemetryService]. */
    public fun currentConfig(): TelemetryConfig {
        val values = load()
        return TelemetryConfig.fromFields(
            isEnabled = values.isEnabled,
            sendTranscripts = values.sendTranscripts,
            endpointField = values.endpoint,
            apiKeyField = values.apiKey,
        )
    }

    public companion object {
        // Keys match the Swift originals exactly. They are not shared across platforms, but a
        // mismatch would be invisible and would silently reset a user's settings on a future
        // rename, so they are worth keeping identical.
        public const val KEY_ENABLED: String = "telemetry.enabled"
        public const val KEY_SEND_TRANSCRIPTS: String = "telemetry.sendTranscripts"
        public const val KEY_ENDPOINT: String = "telemetry.endpoint"
        public const val KEY_API_KEY_ACCOUNT: String = "telemetry.apiKey"
    }
}
