package com.keegancodes.ondas.kit.telemetry

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.nio.ByteBuffer
import java.security.SecureRandom
import java.util.UUID
import kotlin.time.Instant

/**
 * Central, app-wide sink for on-device model telemetry. Emits model id, token counts, tool calls
 * and timing as OTLP spans. Prompt and reply text are attached only when transcript capture is
 * explicitly enabled. No-ops entirely unless telemetry is enabled and configured in Settings.
 *
 * Swift makes this an `actor` with a `static let shared`. Here the mutable config is guarded by a
 * [Mutex] and the single instance is owned by the app's object graph rather than by a global —
 * consistent with the hand-wired container this port already uses, and it means a test can build
 * one without reaching through a singleton.
 */
public class TelemetryService(
    private val exporter: OtlpExporter,
    /**
     * Reported as `llm.model_name`. Swift hard-codes the synthetic `"apple-on-device"` because
     * `SystemLanguageModel` exposes no name; ML Kit's `getBaseModelName()` does, and Android
     * reports that real value (approved 2026-08-27, PORTING.md § Spec #90 notes).
     *
     * A SUSPENDING SUPPLIER rather than a `String`, because the real name can only be obtained by
     * asking the model, which suspends and can fail before the model is downloaded. An earlier
     * shape took a plain `String` fed from a mutable field on the graph — which captured the
     * fallback at construction and could never be updated, so every span would have shipped
     * `google-on-device` and quietly contradicted the approved decision. Caught in review.
     *
     * No default, on purpose: this is the field coding-stats groups usage by. Note the value
     * CHANGES as Google ships new Nano versions — accepted, since the real name is the more
     * truthful datum.
     */
    private val modelName: suspend () -> String,
) {
    private val mutex = Mutex()
    private var config: TelemetryConfig = TelemetryConfig.DISABLED

    /**
     * Whether telemetry can currently be delivered. A cheap gate callers check before doing any
     * telemetry-only work (such as counting reply tokens) that would be wasted when disabled.
     */
    public suspend fun isDeliverable(): Boolean = mutex.withLock { config.isDeliverable }

    /** Replaces the active configuration (from app launch and the settings screen). */
    public suspend fun update(config: TelemetryConfig) {
        mutex.withLock { this.config = config }
        if (!config.sendTranscripts) {
            exporter.removeTranscriptContent()
        }
    }

    /**
     * Records one on-device model invocation as an `ondas.llm` span. [feature] distinguishes the
     * call site (e.g. `chat`, `compaction`) so future sub-agents and classifiers stay separable.
     */
    public suspend fun recordLLM(
        conversationId: UUID,
        feature: String,
        prompt: String,
        completion: String,
        inputTokens: Int,
        outputTokens: Int,
        start: Instant,
        end: Instant,
    ) {
        val active = mutex.withLock { config }
        if (!active.isDeliverable) return
        val attributes = buildList {
            add(stringAttribute("session.id", conversationId.toString()))
            add(stringAttribute("ondas.feature", feature))
            add(stringAttribute("llm.model_name", modelName()))
            add(intAttribute("llm.token_count.prompt", inputTokens))
            add(intAttribute("llm.token_count.completion", outputTokens))
            addAll(transcriptAttributes(prompt, completion, active.sendTranscripts))
        }
        exporter.enqueue(
            listOf(
                TelemetrySpan(
                    name = "ondas.llm",
                    traceIdHex = traceId(conversationId),
                    spanIdHex = randomSpanId(),
                    startUnixNano = unixNano(start),
                    endUnixNano = unixNano(end),
                    attributes = attributes,
                ),
            ),
            active,
        )
    }

    /**
     * Records one tool invocation as an `ondas.tool` span.
     *
     * Nothing calls this yet: the only tool on iOS is image generation, which is cut from Android
     * v1. It is ported anyway because it is part of the coding-stats contract and the alternative
     * is re-deriving it when a tool does arrive.
     */
    public suspend fun recordToolCall(
        conversationId: UUID,
        toolName: String,
        start: Instant,
        end: Instant,
    ) {
        val active = mutex.withLock { config }
        if (!active.isDeliverable) return
        exporter.enqueue(
            listOf(
                TelemetrySpan(
                    name = "ondas.tool",
                    traceIdHex = traceId(conversationId),
                    spanIdHex = randomSpanId(),
                    startUnixNano = unixNano(start),
                    endUnixNano = unixNano(end),
                    attributes = listOf(
                        stringAttribute("session.id", conversationId.toString()),
                        stringAttribute("tool_name", toolName),
                    ),
                ),
            ),
            active,
        )
    }

    /**
     * Sends a single synthetic span to verify a just-entered endpoint and key, reporting whether
     * the collector accepted it. Drives the Settings "Send test event" button.
     */
    public suspend fun sendTestEvent(config: TelemetryConfig, now: Instant): Boolean {
        val span = TelemetrySpan(
            name = "ondas.llm",
            traceIdHex = traceId(UUID.randomUUID()),
            spanIdHex = randomSpanId(),
            startUnixNano = unixNano(now),
            endUnixNano = unixNano(now),
            attributes = listOf(
                stringAttribute("session.id", UUID.randomUUID().toString()),
                stringAttribute("ondas.feature", "test"),
                stringAttribute("llm.model_name", modelName()),
                intAttribute("llm.token_count.prompt", 0),
                intAttribute("llm.token_count.completion", 0),
            ),
        )
        return exporter.deliver(listOf(span), config)
    }

    public companion object {
        private val random = SecureRandom()

        private val messageJson = Json { encodeDefaults = true; explicitNulls = false }

        private fun stringAttribute(key: String, value: String) =
            TelemetrySpan.Attribute(key, TelemetrySpan.AttributeValue.Str(value))

        private fun intAttribute(key: String, value: Int) =
            TelemetrySpan.Attribute(key, TelemetrySpan.AttributeValue.Num(value))

        /**
         * Deterministic 16-byte trace id (hex) from the conversation UUID, so every span of one
         * conversation groups under a single trace.
         *
         * Swift reads the raw bytes of `uuid_t`, which are in the same order the canonical string
         * form prints them — so this is equivalent to the dashless lowercase UUID, and a test pins
         * that equivalence rather than leaving it to be assumed.
         */
        public fun traceId(id: UUID): String {
            val bytes = ByteBuffer.allocate(16)
                .putLong(id.mostSignificantBits)
                .putLong(id.leastSignificantBits)
                .array()
            return hex(bytes)
        }

        /** Fresh random 8-byte span id (hex) per span. */
        public fun randomSpanId(): String {
            val bytes = ByteArray(8)
            random.nextBytes(bytes)
            return hex(bytes)
        }

        /**
         * Nanoseconds since the Unix epoch, clamped at zero for pre-epoch instants.
         *
         * Computed in integer arithmetic. Swift multiplies a `Double` `timeIntervalSince1970` by
         * 1e9, which for present-day instants exceeds the 53-bit mantissa and quantises to ~256ns.
         * Reproducing that rounding deliberately would mean writing a bug on purpose; see
         * PORTING.md § Awaiting approval.
         */
        public fun unixNano(instant: Instant): Long {
            if (instant.epochSeconds < 0) return 0
            val nanos = instant.epochSeconds * 1_000_000_000L + instant.nanosecondsOfSecond
            return if (nanos > 0) nanos else 0
        }

        /** OpenTelemetry GenAI content attributes use JSON arrays of structured messages. */
        public fun transcriptAttributes(
            prompt: String,
            completion: String,
            enabled: Boolean,
        ): List<TelemetrySpan.Attribute> {
            if (!enabled) return emptyList()
            return listOf(
                stringAttribute("gen_ai.input.messages", transcriptJson(role = "user", text = prompt)),
                stringAttribute("gen_ai.output.messages", transcriptJson(role = "assistant", text = completion)),
            )
        }

        public fun transcriptJson(role: String, text: String): String =
            runCatching {
                messageJson.encodeToString(
                    listOf(TranscriptMessage(role, listOf(TranscriptMessage.Part("text", text)))),
                )
            }.getOrDefault("[]")

        private fun hex(bytes: ByteArray): String =
            bytes.joinToString("") { "%02x".format(it) }
    }

    @Serializable
    private data class TranscriptMessage(val role: String, val parts: List<Part>) {
        @Serializable data class Part(val type: String, val content: String)
    }
}
