package com.keegancodes.ondas.kit

import com.keegancodes.ondas.kit.telemetry.HttpClientConfig
import com.keegancodes.ondas.kit.telemetry.KeyValueStore
import com.keegancodes.ondas.kit.telemetry.OtlpEncoder
import com.keegancodes.ondas.kit.telemetry.OtlpExporter
import com.keegancodes.ondas.kit.telemetry.SecretStore
import com.keegancodes.ondas.kit.telemetry.TelemetryConfig
import com.keegancodes.ondas.kit.telemetry.TelemetryService
import com.keegancodes.ondas.kit.telemetry.TelemetrySettingsStore
import com.keegancodes.ondas.kit.telemetry.TelemetrySpan
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.util.UUID
import kotlin.time.Instant

/**
 * Port of `OndasTests/TelemetryTests.swift` — all 13 tests, plus additions marked below.
 *
 * This is the one part of the app with a contract outside the repo, so the wire-format test also
 * decodes `contracts/otlp/llm_span.json`, the fixture the Swift suite decodes.
 */
class TelemetryTest {

    private val endpoint = "https://example.com/api/otlp".toHttpUrl()

    // MARK: - TelemetryConfig gating

    @Test
    fun `config is deliverable only when enabled endpoint and key are present`() {
        assertFalse(TelemetryConfig(false, false, endpoint, "k").isDeliverable)
        assertFalse(TelemetryConfig(true, false, null, "k").isDeliverable)
        assertFalse(TelemetryConfig(true, false, endpoint, null).isDeliverable)
        assertFalse(TelemetryConfig(true, false, endpoint, "").isDeliverable)
        assertTrue(TelemetryConfig(true, false, endpoint, "k").isDeliverable)
        assertFalse(TelemetryConfig.DISABLED.isDeliverable)
    }

    @Test
    fun `field init trims and treats blank as absent`() {
        val config = TelemetryConfig.fromFields(
            isEnabled = true,
            sendTranscripts = false,
            endpointField = "  https://example.com/api/otlp  ",
            apiKeyField = "  otlp_key  ",
        )
        assertEquals(endpoint, config.endpoint)
        assertEquals("otlp_key", config.apiKey)

        val blank = TelemetryConfig.fromFields(true, false, "   ", "")
        assertNull(blank.endpoint)
        assertNull(blank.apiKey)
        assertFalse(blank.isDeliverable)
    }

    @Test
    fun `config rejects invalid or insecure endpoints`() {
        val insecure = TelemetryConfig.fromFields(true, false, "http://example.com/api/otlp", "otlp_key")
        assertNull(insecure.endpoint)
        assertFalse(insecure.isDeliverable)

        val malformed = TelemetryConfig.fromFields(true, false, "not a URL", "otlp_key")
        assertNull(malformed.endpoint)
        assertFalse(malformed.isDeliverable)

        val directInsecure = TelemetryConfig(
            isEnabled = true,
            sendTranscripts = false,
            endpoint = "http://example.com/api/otlp".toHttpUrlOrNull(),
            apiKey = "otlp_key",
        )
        assertFalse(directInsecure.isDeliverable)
    }

    // MARK: - Wire helpers

    @Test
    fun `trace id is deterministic 32 hex chars from the conversation uuid`() {
        val id = UUID.randomUUID()
        val trace = TelemetryService.traceId(id)
        assertEquals(32, trace.length)
        assertTrue(trace.all { it.isDigit() || it in 'a'..'f' })
        assertEquals(trace, TelemetryService.traceId(id))
        assertTrue(TelemetryService.traceId(UUID.randomUUID()) != trace)
    }

    /**
     * ADDED (no Swift counterpart). Swift derives the trace id from the raw bytes of `uuid_t`;
     * this port derives it from the two `Long` halves. Pinning the equivalence to the canonical
     * dashless string means a byte-order mistake fails here rather than silently splitting one
     * conversation's spans across two traces in coding-stats.
     */
    @Test
    fun `trace id equals the dashless lowercase uuid`() {
        val id = UUID.fromString("0123456f-89ab-cdef-0123-456789abcdef")
        assertEquals("0123456f89abcdef0123456789abcdef", TelemetryService.traceId(id))
        assertEquals(id.toString().replace("-", "").lowercase(), TelemetryService.traceId(id))
        // A byte-order slip would still produce 32 hex chars, so the literal above is the check
        // that matters -- it fails if the halves or their bytes are transposed.
        assertEquals(
            "ffffffffffffffff0000000000000000",
            TelemetryService.traceId(UUID(-1L, 0L)),
        )
    }

    @Test
    fun `span id is 16 hex chars and random`() {
        val a = TelemetryService.randomSpanId()
        val b = TelemetryService.randomSpanId()
        assertEquals(16, a.length)
        assertTrue(a.all { it.isDigit() || it in 'a'..'f' })
        assertTrue(a != b)
    }

    @Test
    fun `unix nano converts seconds to nanoseconds`() {
        assertEquals(1_000_000_000L, TelemetryService.unixNano(Instant.fromEpochSeconds(1)))
        assertEquals(0L, TelemetryService.unixNano(Instant.fromEpochSeconds(-5)))
    }

    @Test
    fun `transcript json uses the gen ai message shape`() {
        val parsed = Json.parseToJsonElement(
            TelemetryService.transcriptJson(role = "user", text = "Hello"),
        ).jsonArray
        val message = parsed.first().jsonObject
        assertEquals("user", message["role"]?.jsonPrimitive?.content)
        val part = message["parts"]!!.jsonArray.first().jsonObject
        assertEquals("text", part["type"]?.jsonPrimitive?.content)
        assertEquals("Hello", part["content"]?.jsonPrimitive?.content)
    }

    @Test
    fun `transcript attributes are opt in and can be scrubbed`() {
        assertTrue(
            TelemetryService.transcriptAttributes("private prompt", "private reply", enabled = false).isEmpty(),
        )

        val transcript = TelemetryService.transcriptAttributes("private prompt", "private reply", enabled = true)
        assertEquals(
            listOf("gen_ai.input.messages", "gen_ai.output.messages"),
            transcript.map { it.key },
        )

        val span = TelemetrySpan(
            name = "ondas.llm",
            traceIdHex = "trace",
            spanIdHex = "span",
            startUnixNano = 1,
            endUnixNano = 2,
            attributes = listOf(
                TelemetrySpan.Attribute("session.id", TelemetrySpan.AttributeValue.Str("session")),
            ) + transcript,
        )
        assertEquals(
            listOf("session.id"),
            OtlpExporter.removingTranscriptContent(span).attributes.map { it.key },
        )
    }

    // MARK: - OTLP JSON encoding

    private val sampleSpan = TelemetrySpan(
        name = "ondas.llm",
        traceIdHex = "0123456789abcdef0123456789abcdef",
        spanIdHex = "0123456789abcdef",
        startUnixNano = 1_000,
        endUnixNano = 2_000,
        attributes = listOf(
            TelemetrySpan.Attribute("llm.model_name", TelemetrySpan.AttributeValue.Str("apple-on-device")),
            TelemetrySpan.Attribute("llm.token_count.prompt", TelemetrySpan.AttributeValue.Num(5)),
        ),
    )

    @Test
    fun `encodes a span into otlp json matching the ingest shape`() {
        val root = Json.parseToJsonElement(OtlpEncoder.encode(listOf(sampleSpan), "1.0")).jsonObject
        assertSpanShape(root)
    }

    /**
     * ADDED (no Swift counterpart, but it is the point of `contracts/`). Decodes the SAME fixture
     * the Swift suite decodes, so a wire-shape change breaks whichever platform did not change.
     */
    @Test
    fun `encoder output matches the shared contract fixture`() {
        val fixture = contractsFile("otlp/llm_span.json")
        assertTrue(
            "missing contract fixture at ${fixture.absolutePath}",
            fixture.exists(),
        )
        val expected = Json.parseToJsonElement(fixture.readText()).jsonObject
        val actual = Json.parseToJsonElement(OtlpEncoder.encode(listOf(sampleSpan), "1.0")).jsonObject
        // Structural equality, not byte equality: key ORDER is an artifact of each platform's
        // encoder and carries no meaning to the collector, whereas a changed key or a number that
        // stopped being a string absolutely does.
        assertEquals(expected, actual)
        // And the fixture must itself be a valid payload, not just anything that round-trips.
        assertSpanShape(expected)
    }

    private fun assertSpanShape(root: JsonObject) {
        val first = root["resourceSpans"]!!.jsonArray.first().jsonObject

        val resourceAttrs = first["resource"]!!.jsonObject["attributes"]!!.jsonArray
        assertEquals("ondas", attributeString(resourceAttrs, "service.name"))

        val encoded = first["scopeSpans"]!!.jsonArray.first().jsonObject["spans"]!!.jsonArray
            .first().jsonObject

        assertEquals("ondas.llm", encoded["name"]?.jsonPrimitive?.content)
        assertEquals("0123456789abcdef0123456789abcdef", encoded["traceId"]?.jsonPrimitive?.content)
        assertEquals("0123456789abcdef", encoded["spanId"]?.jsonPrimitive?.content)
        // 64-bit ints are STRINGS in protobuf JSON.
        assertEquals("1000", encoded["startTimeUnixNano"]?.jsonPrimitive?.content)
        assertTrue(encoded["startTimeUnixNano"]!!.jsonPrimitive.isString)
        assertEquals("2000", encoded["endTimeUnixNano"]?.jsonPrimitive?.content)

        val attrs = encoded["attributes"]!!.jsonArray
        assertEquals("apple-on-device", attributeString(attrs, "llm.model_name"))
        val tokenValue = attrs.map { it.jsonObject }
            .first { it["key"]?.jsonPrimitive?.content == "llm.token_count.prompt" }["value"]!!.jsonObject
        assertEquals("5", tokenValue["intValue"]?.jsonPrimitive?.content)
        assertTrue(tokenValue["intValue"]!!.jsonPrimitive.isString)
        assertNull(tokenValue["stringValue"])
    }

    private fun attributeString(attributes: JsonArray, key: String): String? =
        attributes.map { it.jsonObject }
            .firstOrNull { it["key"]?.jsonPrimitive?.content == key }
            ?.get("value")?.jsonObject?.get("stringValue")?.jsonPrimitive?.content

    // MARK: - Transport configuration
    //
    // ADDED. Asserted as CONFIGURATION rather than behaviour because neither value is observable
    // through a MockWebServer test: localhost answers instantly and never saturates a dispatcher.
    // Both were introduced by OMISSION on the sibling ports, which is the hardest kind of defect
    // to see in review -- there is no line of code to look at.

    @Test
    fun `http client uses URLSession's timeout not OkHttp's`() {
        val client = HttpClientConfig.shared
        assertEquals(60_000, client.connectTimeoutMillis)
        assertEquals(60_000, client.readTimeoutMillis)
        assertEquals(60_000, client.writeTimeoutMillis)
        assertEquals(16, client.dispatcher.maxRequestsPerHost)
    }

    @Test
    fun `traces path is appended once regardless of a trailing slash`() {
        assertEquals(
            "https://example.com/api/otlp/v1/traces",
            OtlpExporter.tracesUrl("https://example.com/api/otlp".toHttpUrl()).toString(),
        )
        assertEquals(
            "https://example.com/api/otlp/v1/traces",
            OtlpExporter.tracesUrl("https://example.com/api/otlp/".toHttpUrl()).toString(),
        )
    }

    // MARK: - Settings round-trip

    private class InMemorySecretStore : SecretStore {
        private val storage = mutableMapOf<String, String>()
        override fun secret(account: String): String? = storage[account]
        override fun setSecret(value: String?, account: String) {
            if (!value.isNullOrEmpty()) storage[account] = value else storage.remove(account)
        }
    }

    private class InMemoryKeyValueStore : KeyValueStore {
        private val storage = mutableMapOf<String, Any>()
        override fun string(key: String): String? = storage[key] as? String
        override fun boolean(key: String): Boolean = storage[key] as? Boolean ?: false
        override fun putString(key: String, value: String) { storage[key] = value }
        override fun putBoolean(key: String, value: Boolean) { storage[key] = value }
    }

    @Test
    fun `settings store has no default endpoint`() {
        val store = TelemetrySettingsStore(InMemoryKeyValueStore(), InMemorySecretStore())
        assertTrue(store.load().endpoint.isEmpty())
        assertFalse(store.load().sendTranscripts)
        assertNull(store.currentConfig().endpoint)
        assertFalse(store.currentConfig().sendTranscripts)
    }

    @Test
    fun `settings store round trips through defaults and the secret store`() {
        val store = TelemetrySettingsStore(InMemoryKeyValueStore(), InMemorySecretStore())
        store.save(true, true, "https://example.com/api/otlp", "otlp_key")

        val values = store.load()
        assertTrue(values.isEnabled)
        assertTrue(values.sendTranscripts)
        assertEquals("https://example.com/api/otlp", values.endpoint)
        assertEquals("otlp_key", values.apiKey)

        val config = store.currentConfig()
        assertTrue(config.isDeliverable)
        assertTrue(config.sendTranscripts)
        assertEquals(endpoint, config.endpoint)
        assertEquals("otlp_key", config.apiKey)
    }

    @Test
    fun `settings store clears the key and yields an undeliverable config when blank`() {
        val secrets = InMemorySecretStore()
        val store = TelemetrySettingsStore(InMemoryKeyValueStore(), secrets)

        store.save(true, false, "https://example.com/api/otlp", "otlp_key")
        store.save(true, false, "https://example.com/api/otlp", "")

        assertEquals("", store.load().apiKey)
        assertNull(secrets.secret(TelemetrySettingsStore.KEY_API_KEY_ACCOUNT))
        assertFalse(store.currentConfig().isDeliverable)
    }

    /**
     * Resolves a path under the repo-root `contracts/` directory. Read IN PLACE rather than copied
     * into the module: a duplicated fixture is exactly how the drift a shared fixture exists to
     * prevent gets hidden.
     */
    private fun contractsFile(relative: String): File {
        val fromProperty = System.getProperty("ondas.contracts")
        assertNotNull("ondas.contracts system property not set by the build", fromProperty)
        return File(fromProperty!!, relative)
    }
}
