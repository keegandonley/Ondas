package com.keegancodes.ondas.kit.telemetry

/**
 * One OTLP span the app wants to deliver. A plain immutable value so it can be built anywhere and
 * handed to the exporter.
 */
public data class TelemetrySpan(
    public val name: String,
    public val traceIdHex: String,
    public val spanIdHex: String,
    public val startUnixNano: Long,
    public val endUnixNano: Long,
    public val attributes: List<Attribute>,
) {
    public data class Attribute(
        public val key: String,
        public val value: AttributeValue,
    )

    public sealed interface AttributeValue {
        public data class Str(public val value: String) : AttributeValue
        public data class Num(public val value: Int) : AttributeValue
    }
}
