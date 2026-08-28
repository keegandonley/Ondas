package com.keegancodes.ondas.kit.telemetry

import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/**
 * Builds the OTLP/HTTP JSON `resourceSpans` payload.
 *
 * This is the one part of the app with a contract outside the repo: coding-stats ingests these
 * spans. The shape is pinned by `contracts/otlp/llm_span.json`, which both this suite and the
 * Swift suite decode — a hand-checked copy on each side would drift silently.
 *
 * `intValue` and the timestamps are STRINGS because protobuf JSON encodes 64-bit integers as
 * strings. That is not a quirk to tidy up; the ingest parses them back to numbers.
 */
public object OtlpEncoder {
    /**
     * `explicitNulls = false` reproduces `JSONEncoder`'s behaviour of omitting a nil rather than
     * writing `"key": null` — load-bearing for [AnyValue], where exactly one of the two fields is
     * populated and the other must not appear. `encodeDefaults = true` because kotlinx otherwise
     * OMITS any property equal to its default, which would silently drop fields the ingest needs.
     */
    private val json: Json = Json {
        encodeDefaults = true
        explicitNulls = false
        ignoreUnknownKeys = true
    }

    public fun encode(spans: List<TelemetrySpan>, serviceVersion: String): String {
        val payload = Payload(
            resourceSpans = listOf(
                ResourceSpans(
                    resource = Resource(
                        attributes = listOf(
                            KeyValue("service.name", AnyValue(stringValue = "ondas")),
                            KeyValue("service.version", AnyValue(stringValue = serviceVersion)),
                        ),
                    ),
                    scopeSpans = listOf(
                        ScopeSpans(
                            scope = Scope(name = "ondas", version = serviceVersion),
                            spans = spans.map(::encodeSpan),
                        ),
                    ),
                ),
            ),
        )
        return json.encodeToString(payload)
    }

    private fun encodeSpan(span: TelemetrySpan) = Span(
        traceId = span.traceIdHex,
        spanId = span.spanIdHex,
        name = span.name,
        kind = 1, // SPAN_KIND_INTERNAL
        startTimeUnixNano = span.startUnixNano.toString(),
        endTimeUnixNano = span.endUnixNano.toString(),
        attributes = span.attributes.map { attribute ->
            when (val value = attribute.value) {
                is TelemetrySpan.AttributeValue.Str ->
                    KeyValue(attribute.key, AnyValue(stringValue = value.value))
                is TelemetrySpan.AttributeValue.Num ->
                    KeyValue(attribute.key, AnyValue(intValue = value.value.toString()))
            }
        },
    )

    @Serializable private data class Payload(val resourceSpans: List<ResourceSpans>)
    @Serializable private data class ResourceSpans(val resource: Resource, val scopeSpans: List<ScopeSpans>)
    @Serializable private data class Resource(val attributes: List<KeyValue>)
    @Serializable private data class ScopeSpans(val scope: Scope, val spans: List<Span>)
    @Serializable private data class Scope(val name: String, val version: String)

    @Serializable
    private data class Span(
        val traceId: String,
        val spanId: String,
        val name: String,
        val kind: Int,
        val startTimeUnixNano: String,
        val endTimeUnixNano: String,
        val attributes: List<KeyValue>,
    )

    @Serializable private data class KeyValue(val key: String, val value: AnyValue)

    @Serializable
    private data class AnyValue(
        val stringValue: String? = null,
        val intValue: String? = null,
    )
}
