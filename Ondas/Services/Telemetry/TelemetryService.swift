import Foundation

/// Central, app-wide sink for on-device model telemetry. Emits model id, token counts, tool calls,
/// and timing as OTLP spans. Prompt and reply text are attached only when transcript capture is
/// explicitly enabled. No-ops entirely unless telemetry is enabled and configured in Settings.
///
/// An `actor` so callers can fire-and-forget from the main actor without blocking a chat turn, and so
/// the buffered exporter stays race-free under Swift 6 strict concurrency.
actor TelemetryService {
    static let shared = TelemetryService()

    private var config: TelemetryConfig = .disabled
    private let exporter: OTLPExporter

    /// Synthetic model id — the on-device `SystemLanguageModel` exposes no name/version string.
    private static let modelName = "apple-on-device"

    private init() {
        let version = Bundle.main
            .object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown"
        exporter = OTLPExporter(serviceVersion: version)
    }

    /// Whether telemetry can currently be delivered. Cheap gate callers can check before doing any
    /// telemetry-only work (e.g. counting reply tokens) that would be wasted when disabled.
    var isDeliverable: Bool { config.isDeliverable }

    /// Replaces the active configuration (from app launch and the settings screen).
    func update(_ config: TelemetryConfig) async {
        self.config = config
        if !config.sendTranscripts {
            await exporter.removeTranscriptContent()
        }
    }

    /// Records one on-device model invocation as an `ondas.llm` span. `feature` distinguishes the
    /// call site (e.g. `chat`) so future sub-agents/classifiers are counted and separable.
    func recordLLM(
        conversationID: UUID,
        feature: String,
        prompt: String,
        completion: String,
        inputTokens: Int,
        outputTokens: Int,
        start: Date,
        end: Date
    ) async {
        guard config.isDeliverable else { return }
        var attributes: [TelemetrySpan.Attribute] = [
            .init(key: "session.id", value: .string(conversationID.uuidString)),
            .init(key: "ondas.feature", value: .string(feature)),
            .init(key: "llm.model_name", value: .string(Self.modelName)),
            .init(key: "llm.token_count.prompt", value: .int(inputTokens)),
            .init(key: "llm.token_count.completion", value: .int(outputTokens)),
        ]
        attributes.append(contentsOf: Self.transcriptAttributes(
            prompt: prompt,
            completion: completion,
            enabled: config.sendTranscripts
        ))
        let span = TelemetrySpan(
            name: "ondas.llm",
            traceIdHex: Self.traceId(for: conversationID),
            spanIdHex: Self.randomSpanId(),
            startUnixNano: Self.unixNano(start),
            endUnixNano: Self.unixNano(end),
            attributes: attributes
        )
        await exporter.enqueue([span], config: config)
    }

    /// Records one tool invocation (e.g. on-device image generation) as an `ondas.tool` span.
    func recordToolCall(
        conversationID: UUID,
        toolName: String,
        start: Date,
        end: Date
    ) async {
        guard config.isDeliverable else { return }
        let span = TelemetrySpan(
            name: "ondas.tool",
            traceIdHex: Self.traceId(for: conversationID),
            spanIdHex: Self.randomSpanId(),
            startUnixNano: Self.unixNano(start),
            endUnixNano: Self.unixNano(end),
            attributes: [
                .init(key: "session.id", value: .string(conversationID.uuidString)),
                .init(key: "tool_name", value: .string(toolName)),
            ]
        )
        await exporter.enqueue([span], config: config)
    }

    /// Sends a single synthetic span to verify the given (just-entered) endpoint + key, returning
    /// whether the collector accepted it. Used by the Settings "Send test event" button.
    func sendTestEvent(using config: TelemetryConfig) async -> Bool {
        let now = Date()
        let span = TelemetrySpan(
            name: "ondas.llm",
            traceIdHex: Self.traceId(for: UUID()),
            spanIdHex: Self.randomSpanId(),
            startUnixNano: Self.unixNano(now),
            endUnixNano: Self.unixNano(now),
            attributes: [
                .init(key: "session.id", value: .string(UUID().uuidString)),
                .init(key: "ondas.feature", value: .string("test")),
                .init(key: "llm.model_name", value: .string(Self.modelName)),
                .init(key: "llm.token_count.prompt", value: .int(0)),
                .init(key: "llm.token_count.completion", value: .int(0)),
            ]
        )
        return await exporter.deliver([span], config: config)
    }

    // MARK: - Wire helpers

    /// Deterministic 16-byte trace id (hex) from the conversation UUID, so all of a conversation's
    /// spans group under one trace.
    static func traceId(for id: UUID) -> String {
        withUnsafeBytes(of: id.uuid) { hex(Array($0)) }
    }

    /// Fresh random 8-byte span id (hex) per span.
    static func randomSpanId() -> String {
        var bytes = [UInt8](repeating: 0, count: 8)
        for index in bytes.indices { bytes[index] = UInt8.random(in: .min ... .max) }
        return hex(bytes)
    }

    static func unixNano(_ date: Date) -> UInt64 {
        let nanos = date.timeIntervalSince1970 * 1_000_000_000
        return nanos > 0 ? UInt64(nanos) : 0
    }

    /// OpenTelemetry GenAI content attributes use JSON arrays of structured messages.
    static func transcriptAttributes(
        prompt: String,
        completion: String,
        enabled: Bool
    ) -> [TelemetrySpan.Attribute] {
        guard enabled else { return [] }
        return [
            .init(
                key: "gen_ai.input.messages",
                value: .string(transcriptJSON(role: "user", text: prompt))
            ),
            .init(
                key: "gen_ai.output.messages",
                value: .string(transcriptJSON(role: "assistant", text: completion))
            ),
        ]
    }

    static func transcriptJSON(role: String, text: String) -> String {
        let message = TranscriptMessage(role: role, parts: [.init(type: "text", content: text)])
        let data = try? JSONEncoder().encode([message])
        return data.flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
    }

    private struct TranscriptMessage: Encodable {
        let role: String
        let parts: [Part]

        struct Part: Encodable {
            let type: String
            let content: String
        }
    }

    private static func hex(_ bytes: [UInt8]) -> String {
        bytes.map { String(format: "%02x", $0) }.joined()
    }
}
