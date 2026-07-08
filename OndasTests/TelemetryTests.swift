import Foundation
import Testing
@testable import Ondas

/// Coverage for the telemetry plumbing: config gating, the OTLP JSON wire format (the part that must
/// stay compatible with the coding-stats ingest), the trace/span id + timestamp helpers, and the
/// settings round-trip. Live delivery needs a real endpoint and isn't exercised here.
struct TelemetryTests {
    // MARK: TelemetryConfig gating

    @Test func configIsDeliverableOnlyWhenEnabledEndpointAndKeyPresent() {
        let endpoint = URL(string: "https://example.com/api/otlp")

        #expect(!TelemetryConfig(
            isEnabled: false,
            sendTranscripts: false,
            endpoint: endpoint,
            apiKey: "k"
        ).isDeliverable)
        #expect(!TelemetryConfig(
            isEnabled: true,
            sendTranscripts: false,
            endpoint: nil,
            apiKey: "k"
        ).isDeliverable)
        #expect(!TelemetryConfig(
            isEnabled: true,
            sendTranscripts: false,
            endpoint: endpoint,
            apiKey: nil
        ).isDeliverable)
        #expect(!TelemetryConfig(
            isEnabled: true,
            sendTranscripts: false,
            endpoint: endpoint,
            apiKey: ""
        ).isDeliverable)
        #expect(TelemetryConfig(
            isEnabled: true,
            sendTranscripts: false,
            endpoint: endpoint,
            apiKey: "k"
        ).isDeliverable)
        #expect(!TelemetryConfig.disabled.isDeliverable)
    }

    @Test func configFieldInitTrimsAndTreatsBlankAsAbsent() {
        let config = TelemetryConfig(
            isEnabled: true,
            sendTranscripts: false,
            endpointField: "  https://example.com/api/otlp  ",
            apiKeyField: "  otlp_key  "
        )
        #expect(config.endpoint == URL(string: "https://example.com/api/otlp"))
        #expect(config.apiKey == "otlp_key")

        let blank = TelemetryConfig(
            isEnabled: true,
            sendTranscripts: false,
            endpointField: "   ",
            apiKeyField: ""
        )
        #expect(blank.endpoint == nil)
        #expect(blank.apiKey == nil)
        #expect(!blank.isDeliverable)
    }

    // MARK: Wire helpers

    @Test func traceIdIsDeterministic32HexCharsFromConversationUUID() {
        let id = UUID()
        let trace = TelemetryService.traceId(for: id)
        #expect(trace.count == 32)
        #expect(trace.allSatisfy { $0.isHexDigit })
        // Deterministic: the same conversation always maps to the same trace id.
        #expect(TelemetryService.traceId(for: id) == trace)
        // Distinct conversations get distinct trace ids.
        #expect(TelemetryService.traceId(for: UUID()) != trace)
    }

    @Test func spanIdIs16HexCharsAndRandom() {
        let a = TelemetryService.randomSpanId()
        let b = TelemetryService.randomSpanId()
        #expect(a.count == 16)
        #expect(a.allSatisfy { $0.isHexDigit })
        #expect(a != b)
    }

    @Test func unixNanoConvertsSecondsToNanoseconds() {
        let date = Date(timeIntervalSince1970: 1)
        #expect(TelemetryService.unixNano(date) == 1_000_000_000)
        #expect(TelemetryService.unixNano(Date(timeIntervalSince1970: -5)) == 0)
    }

    @Test func transcriptJSONUsesGenAIMessageShape() throws {
        let data = try #require(
            TelemetryService.transcriptJSON(role: "user", text: "Hello").data(using: .utf8)
        )
        let messages = try #require(
            try JSONSerialization.jsonObject(with: data) as? [[String: Any]]
        )
        let message = try #require(messages.first)
        #expect(message["role"] as? String == "user")
        let parts = try #require(message["parts"] as? [[String: Any]])
        #expect(parts.first?["type"] as? String == "text")
        #expect(parts.first?["content"] as? String == "Hello")
    }

    @Test func transcriptAttributesAreOptInAndCanBeScrubbed() {
        #expect(
            TelemetryService.transcriptAttributes(
                prompt: "private prompt",
                completion: "private reply",
                enabled: false
            ).isEmpty
        )

        let transcriptAttributes = TelemetryService.transcriptAttributes(
            prompt: "private prompt",
            completion: "private reply",
            enabled: true
        )
        #expect(transcriptAttributes.map(\.key) == [
            "gen_ai.input.messages",
            "gen_ai.output.messages",
        ])

        let span = TelemetrySpan(
            name: "ondas.llm",
            traceIdHex: "trace",
            spanIdHex: "span",
            startUnixNano: 1,
            endUnixNano: 2,
            attributes: [.init(key: "session.id", value: .string("session"))]
                + transcriptAttributes
        )
        let scrubbed = OTLPExporter.removingTranscriptContent(from: span)
        #expect(scrubbed.attributes.map(\.key) == ["session.id"])
    }

    // MARK: OTLP JSON encoding

    @Test func encodesSpanIntoOtlpJsonMatchingIngestShape() throws {
        let span = TelemetrySpan(
            name: "ondas.llm",
            traceIdHex: "0123456789abcdef0123456789abcdef",
            spanIdHex: "0123456789abcdef",
            startUnixNano: 1_000,
            endUnixNano: 2_000,
            attributes: [
                .init(key: "llm.model_name", value: .string("apple-on-device")),
                .init(key: "llm.token_count.prompt", value: .int(5)),
            ]
        )

        let data = try OTLPExporter.encode([span], serviceVersion: "1.0")
        let root = try #require(
            try JSONSerialization.jsonObject(with: data) as? [String: Any]
        )

        let resourceSpans = try #require(root["resourceSpans"] as? [[String: Any]])
        let first = try #require(resourceSpans.first)

        // Resource carries the service name the ingest labels the source with.
        let resourceAttrs = try #require(
            (first["resource"] as? [String: Any])?["attributes"] as? [[String: Any]]
        )
        #expect(attributeString(resourceAttrs, key: "service.name") == "ondas")

        let scopeSpans = try #require(first["scopeSpans"] as? [[String: Any]])
        let spans = try #require(scopeSpans.first?["spans"] as? [[String: Any]])
        let encoded = try #require(spans.first)

        #expect(encoded["name"] as? String == "ondas.llm")
        #expect(encoded["traceId"] as? String == "0123456789abcdef0123456789abcdef")
        #expect(encoded["spanId"] as? String == "0123456789abcdef")
        // 64-bit ints are strings in protobuf JSON.
        #expect(encoded["startTimeUnixNano"] as? String == "1000")
        #expect(encoded["endTimeUnixNano"] as? String == "2000")

        let attrs = try #require(encoded["attributes"] as? [[String: Any]])
        #expect(attributeString(attrs, key: "llm.model_name") == "apple-on-device")
        // Int attributes encode as { intValue: "5" } (string), which the ingest parses back to a number.
        let tokenValue = try #require(
            attrs.first { $0["key"] as? String == "llm.token_count.prompt" }?["value"] as? [String: Any]
        )
        #expect(tokenValue["intValue"] as? String == "5")
        #expect(tokenValue["stringValue"] == nil)
    }

    // MARK: Settings round-trip

    @MainActor
    @Test func settingsStoreHasNoDefaultEndpoint() throws {
        let suite = "telemetry.tests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = TelemetrySettingsStore(defaults: defaults, secrets: InMemorySecretStore())

        #expect(store.load().endpoint.isEmpty)
        #expect(!store.load().sendTranscripts)
        #expect(store.currentConfig().endpoint == nil)
        #expect(!store.currentConfig().sendTranscripts)
    }

    @MainActor
    @Test func settingsStoreRoundTripsThroughDefaultsAndSecretStore() throws {
        let suite = "telemetry.tests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let secrets = InMemorySecretStore()
        let store = TelemetrySettingsStore(defaults: defaults, secrets: secrets)

        store.save(
            isEnabled: true,
            sendTranscripts: true,
            endpoint: "https://example.com/api/otlp",
            apiKey: "otlp_key"
        )

        let values = store.load()
        #expect(values.isEnabled)
        #expect(values.sendTranscripts)
        #expect(values.endpoint == "https://example.com/api/otlp")
        #expect(values.apiKey == "otlp_key")

        let config = store.currentConfig()
        #expect(config.isDeliverable)
        #expect(config.sendTranscripts)
        #expect(config.endpoint == URL(string: "https://example.com/api/otlp"))
        #expect(config.apiKey == "otlp_key")
    }

    @MainActor
    @Test func settingsStoreClearsKeyAndYieldsUndeliverableConfigWhenBlank() throws {
        let suite = "telemetry.tests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let secrets = InMemorySecretStore()
        let store = TelemetrySettingsStore(defaults: defaults, secrets: secrets)

        store.save(
            isEnabled: true,
            sendTranscripts: false,
            endpoint: "https://example.com/api/otlp",
            apiKey: "otlp_key"
        )
        store.save(
            isEnabled: true,
            sendTranscripts: false,
            endpoint: "https://example.com/api/otlp",
            apiKey: ""
        )

        #expect(store.load().apiKey == "")
        #expect(secrets.secret(forKey: "telemetry.apiKey") == nil)
        // Enabled with an endpoint but no key is not deliverable.
        #expect(!store.currentConfig().isDeliverable)
    }

    // MARK: Helpers

    /// Reads the `stringValue` of an OTLP attribute list entry by key.
    private func attributeString(_ attributes: [[String: Any]], key: String) -> String? {
        let value = attributes.first { $0["key"] as? String == key }?["value"] as? [String: Any]
        return value?["stringValue"] as? String
    }
}

/// In-memory `SecretStore` for tests — the Keychain is unavailable/flaky in the unit-test host.
private final class InMemorySecretStore: SecretStore, @unchecked Sendable {
    private var storage: [String: String] = [:]

    func secret(forKey account: String) -> String? { storage[account] }

    func setSecret(_ value: String?, forKey account: String) {
        if let value, !value.isEmpty {
            storage[account] = value
        } else {
            storage[account] = nil
        }
    }
}
