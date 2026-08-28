package com.keegancodes.ondas.kit.telemetry

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import kotlin.math.min

/**
 * Serialises spans into an OTLP/HTTP JSON payload and POSTs them to the configured collector.
 *
 * Best-effort by design: on any failure the spans stay buffered (bounded) for the next flush, and
 * nothing is persisted across launches — this app keeps no on-disk activity log.
 *
 * ## Reproducing Swift's actor semantics
 *
 * The Swift original is an `actor`, which serialises state access but is REENTRANT across `await`.
 * The [isFlushing] guard exists precisely because of that reentrancy: without it a second
 * `enqueue` arriving during a POST would start an overlapping flush and re-send the in-flight
 * spans (they are not removed from the buffer until the POST returns), duplicating them server-side.
 *
 * So the [mutex] here is held only for state mutations and is deliberately RELEASED across the
 * network call. Holding it across the POST would be the easy mistake: it would serialise callers,
 * quietly making [isFlushing] dead code and changing the concurrency behaviour the guard was
 * written to handle.
 */
public class OtlpExporter(
    private val serviceVersion: String,
    private val callFactory: Call.Factory,
    private val onTransportFailure: () -> Unit = {},
) {
    private val mutex = Mutex()
    private val buffer = ArrayDeque<TelemetrySpan>()
    private var isFlushing = false

    /**
     * Removes sensitive content from spans waiting for a retry when transcript capture is turned
     * off. The surrounding usage metrics stay buffered and can still be delivered later.
     */
    public suspend fun removeTranscriptContent() {
        mutex.withLock {
            val scrubbed = buffer.map(::removingTranscriptContent)
            buffer.clear()
            buffer.addAll(scrubbed)
        }
    }

    /**
     * Buffers [spans] and drains the buffer to the collector. When undeliverable (disabled, no
     * endpoint, no key) the spans are still buffered so they can go out once configured.
     */
    public suspend fun enqueue(spans: List<TelemetrySpan>, config: TelemetryConfig) {
        val destination = mutex.withLock {
            buffer.addAll(spans)
            // Never trim while a flush's POST is in flight: flushOnce relies on the buffer front
            // being exactly the batch it snapshotted, so trimming from the front here would make
            // its success path remove newer, never-sent spans. The active flush trims between
            // batches instead, so an overflow during a POST is only ever transient.
            if (!isFlushing) trimBuffer()

            val endpoint = config.endpoint
            val apiKey = config.apiKey
            when {
                !config.isDeliverable || endpoint == null || apiKey == null -> null
                // An in-flight flush will drain what we just appended.
                isFlushing -> null
                else -> {
                    isFlushing = true
                    endpoint to apiKey
                }
            }
        } ?: return

        val (endpoint, apiKey) = destination
        try {
            // Drain until empty or a send fails. Spans appended during a POST are caught on the
            // next iteration, so a burst of turns goes out under one flusher without duplication.
            while (true) {
                if (mutex.withLock { buffer.isEmpty() }) break
                val delivered = flushOnce(endpoint, apiKey)
                mutex.withLock { trimBuffer() } // safe between batches: no snapshot outstanding
                if (!delivered) break
            }
        } finally {
            // NonCancellable is load-bearing, not defensive boilerplate. Swift's
            // `defer { isFlushing = false }` is a synchronous assignment that cancellation cannot
            // skip. `mutex.withLock` SUSPENDS, and a coroutine cancelled mid-POST resumes a
            // contended `lock()` straight into CancellationException — so the lambda would never
            // run, `isFlushing` would stay true, and this app-scoped exporter would refuse to
            // drain again for the rest of the process's life.
            withContext(NonCancellable) { mutex.withLock { isFlushing = false } }
        }
    }

    /**
     * One-shot delivery for the Settings "Send test event" button: POSTs immediately, bypassing the
     * buffer, and reports whether the collector accepted them so the user can verify their endpoint
     * and key before saving.
     */
    public suspend fun deliver(spans: List<TelemetrySpan>, config: TelemetryConfig): Boolean {
        val endpoint = config.endpoint ?: return false
        val apiKey = config.apiKey ?: return false
        if (!config.isDeliverable) return false
        val body = runCatching { OtlpEncoder.encode(spans, serviceVersion) }.getOrNull() ?: return false
        return post(body, endpoint, apiKey)
    }

    /** Drops the oldest spans past [MAX_BUFFERED]. Must not run while a snapshot is outstanding. */
    private fun trimBuffer() {
        while (buffer.size > MAX_BUFFERED) buffer.removeFirst()
    }

    /**
     * POSTs the currently-buffered spans once. Returns whether the caller's drain loop should
     * continue: true when this batch was delivered (or dropped as unencodable) so anything that
     * arrived meanwhile can go next; false on a transient failure so we stop and retry later.
     */
    private suspend fun flushOnce(endpoint: HttpUrl, apiKey: String): Boolean {
        val pending = mutex.withLock { buffer.toList() }
        if (pending.isEmpty()) return false

        val body = try {
            OtlpEncoder.encode(pending, serviceVersion)
        } catch (error: Exception) {
            // An unencodable payload would never succeed; drop it rather than wedge the buffer.
            mutex.withLock { removeFromFront(pending.size) }
            return true
        }

        // On failure (transport or non-2xx, e.g. a bad key) the spans stay buffered for a retry.
        if (!post(body, endpoint, apiKey)) return false
        // Remove only what we sent -- new spans may have been appended during the await, and the
        // buffer is FIFO so the delivered ones are at the front.
        mutex.withLock { removeFromFront(pending.size) }
        return true
    }

    private fun removeFromFront(count: Int) {
        repeat(min(count, buffer.size)) { buffer.removeFirst() }
    }

    /**
     * POSTs an encoded payload to the collector's traces route, reporting whether it was accepted
     * (2xx). The user enters the base OTLP URL and this appends the `v1/traces` signal path.
     */
    private suspend fun post(body: String, endpoint: HttpUrl, apiKey: String): Boolean {
        val request = Request.Builder()
            .url(tracesUrl(endpoint))
            .header("Content-Type", CONTENT_TYPE)
            .header("Authorization", "Bearer $apiKey")
            .post(body.toRequestBody(CONTENT_TYPE.toMediaType()))
            .build()
        return try {
            // OkHttp's execute() blocks the calling thread. Swift's `urlSession.data(for:)` is a
            // true suspension point, so without this the port would block whatever dispatcher the
            // caller happened to be on -- including, from a chat turn, the main one.
            withContext(Dispatchers.IO) {
                callFactory.newCall(request).execute().use { response -> response.isSuccessful }
            }
        } catch (error: Exception) {
            // Transport errors can include the user-supplied endpoint. The Settings screen already
            // reports delivery failure, so keep diagnostics free of connection details.
            onTransportFailure()
            false
        }
    }

    public companion object {
        /**
         * Ceiling on retained spans so a long offline stretch cannot grow memory without bound;
         * the oldest are dropped past this.
         */
        public const val MAX_BUFFERED: Int = 200

        private const val CONTENT_TYPE = "application/json"

        /**
         * The counterpart of Swift's `endpoint.appendingPathComponent("v1/traces")`.
         *
         * `addPathSegments` rather than string concatenation: it also collapses the trailing empty
         * segment a user-entered URL ending in "/" produces, so ".../otlp" and ".../otlp/" both
         * resolve to ".../otlp/v1/traces" instead of one of them growing a double slash.
         */
        public fun tracesUrl(endpoint: HttpUrl): HttpUrl =
            endpoint.newBuilder().addPathSegments("v1/traces").build()

        public fun removingTranscriptContent(span: TelemetrySpan): TelemetrySpan =
            span.copy(attributes = span.attributes.filterNot { it.key in TRANSCRIPT_KEYS })

        private val TRANSCRIPT_KEYS = setOf("gen_ai.input.messages", "gen_ai.output.messages")
    }
}
