import Foundation
import OSLog

/// One OTLP span the app wants to deliver. A plain `Sendable` value so it can be built on the main
/// actor and handed to the exporter actor.
struct TelemetrySpan: Sendable {
    enum AttributeValue: Sendable {
        case string(String)
        case int(Int)
    }

    struct Attribute: Sendable {
        let key: String
        let value: AttributeValue
    }

    let name: String
    let traceIdHex: String
    let spanIdHex: String
    let startUnixNano: UInt64
    let endUnixNano: UInt64
    let attributes: [Attribute]
}

/// Serializes `TelemetrySpan`s into an OTLP/HTTP JSON `resourceSpans` payload and POSTs them to the
/// configured collector. Best-effort by design: on any failure the spans stay buffered (bounded) for
/// the next flush, and nothing is persisted across launches — this app keeps no on-disk activity log.
actor OTLPExporter {
    private let urlSession: URLSession
    private let serviceVersion: String
    private var buffer: [TelemetrySpan] = []

    /// Ceiling on retained spans so a long offline stretch can't grow memory without bound; the
    /// oldest are dropped past this.
    private static let maxBuffered = 200

    private static let logger = Logger(subsystem: AppInfo.bundleID, category: "OTLPExporter")

    init(serviceVersion: String, urlSession: URLSession = .shared) {
        self.serviceVersion = serviceVersion
        self.urlSession = urlSession
    }

    /// Removes sensitive content from spans waiting for a retry when transcript capture is turned
    /// off. The surrounding usage metrics remain buffered and can still be delivered later.
    func removeTranscriptContent() {
        buffer = buffer.map(Self.removingTranscriptContent)
    }

    static func removingTranscriptContent(from span: TelemetrySpan) -> TelemetrySpan {
        let transcriptKeys = ["gen_ai.input.messages", "gen_ai.output.messages"]
        return TelemetrySpan(
            name: span.name,
            traceIdHex: span.traceIdHex,
            spanIdHex: span.spanIdHex,
            startUnixNano: span.startUnixNano,
            endUnixNano: span.endUnixNano,
            attributes: span.attributes.filter { !transcriptKeys.contains($0.key) }
        )
    }

    /// True while a flush is in flight. Actors are reentrant across `await`, so without this a second
    /// `enqueue` arriving during a POST would start an overlapping flush that re-sends the in-flight
    /// spans (they aren't removed from `buffer` until the POST returns), duplicating them on the
    /// server. The guard makes overlapping calls append-and-return; the active flush's drain loop
    /// then picks up whatever they added.
    private var isFlushing = false

    /// Buffers `spans` and drains the buffer to the collector. When undeliverable (disabled / no
    /// endpoint / no key) the spans are still buffered so they can go out once configured.
    func enqueue(_ spans: [TelemetrySpan], config: TelemetryConfig) async {
        buffer.append(contentsOf: spans)
        // Never trim while a flush's POST is in flight: `flushOnce` relies on the buffer front
        // being exactly the batch it snapshotted, so trimming from the front here would make its
        // success path remove newer, never-sent spans. The active flush trims between batches
        // instead, so an overflow during a POST is only ever transient.
        if !isFlushing {
            trimBuffer()
        }
        guard config.isDeliverable, let endpoint = config.endpoint, let apiKey = config.apiKey else {
            return
        }
        guard !isFlushing else { return } // an in-flight flush will drain what we just appended
        isFlushing = true
        defer { isFlushing = false }
        // Drain until empty or a send doesn't succeed. Spans appended during a POST are caught on the
        // next iteration, so a burst of turns still goes out under one flusher without duplication.
        while !buffer.isEmpty {
            let delivered = await flushOnce(endpoint: endpoint, apiKey: apiKey)
            // Safe between batches — no snapshot is outstanding.
            trimBuffer()
            if !delivered { break }
        }
    }

    /// Drops the oldest spans past `maxBuffered`. Must not run while a `flushOnce` snapshot is
    /// outstanding (see `enqueue`).
    private func trimBuffer() {
        if buffer.count > Self.maxBuffered {
            buffer.removeFirst(buffer.count - Self.maxBuffered)
        }
    }

    /// One-shot delivery for the Settings "Send test event" button: POSTs `spans` immediately,
    /// bypassing the buffer, and reports whether the collector accepted them (2xx) so the user can
    /// verify their endpoint + key before saving.
    func deliver(_ spans: [TelemetrySpan], config: TelemetryConfig) async -> Bool {
        guard config.isDeliverable, let endpoint = config.endpoint, let apiKey = config.apiKey else {
            return false
        }
        guard let body = try? Self.encode(spans, serviceVersion: serviceVersion) else {
            return false
        }
        return await post(body, endpoint: endpoint, apiKey: apiKey)
    }

    /// POSTs an encoded OTLP payload to the collector's traces route, reporting whether it was
    /// accepted (2xx). Failures (transport or status) are logged at debug and reported as `false`;
    /// the callers decide whether that means retry-later (`flushOnce`) or a failed test (`deliver`).
    private func post(_ body: Data, endpoint: URL, apiKey: String) async -> Bool {
        var request = URLRequest(url: endpoint.appendingPathComponent("v1/traces"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        request.httpBody = body
        do {
            let (_, response) = try await urlSession.data(for: request)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                return false
            }
            return true
        } catch {
            Self.logger.debug("Telemetry POST failed: \(error, privacy: .public)")
            return false
        }
    }

    /// POSTs the currently-buffered spans once. Returns whether the caller's drain loop should
    /// continue: `true` when this batch was delivered (or dropped as unencodable) so any spans that
    /// arrived meanwhile can go next; `false` on a transient failure so we stop and retry later.
    /// Only the caller (`enqueue`) runs this, and only while `isFlushing` — so no two flushes overlap.
    private func flushOnce(endpoint: URL, apiKey: String) async -> Bool {
        guard !buffer.isEmpty else { return false }

        let pending = buffer
        let body: Data
        do {
            body = try Self.encode(pending, serviceVersion: serviceVersion)
        } catch {
            // An unencodable payload would never succeed; drop it rather than wedge the buffer.
            Self.logger.error("Dropping unencodable telemetry batch: \(error, privacy: .public)")
            buffer.removeFirst(min(pending.count, buffer.count))
            return true
        }

        // On failure (transport or non-2xx, e.g. a bad key) the spans stay buffered for a later retry.
        guard await post(body, endpoint: endpoint, apiKey: apiKey) else { return false }
        // Remove only what we sent — new spans may have been appended during the await, and
        // the buffer is FIFO so the delivered ones are at the front.
        buffer.removeFirst(min(pending.count, buffer.count))
        return true
    }

    /// Builds the OTLP/HTTP JSON `resourceSpans` payload. Static + internal so the wire format can be
    /// unit-tested without a network round-trip.
    static func encode(_ spans: [TelemetrySpan], serviceVersion: String) throws -> Data {
        let resource = OTLP.Resource(attributes: [
            OTLP.KeyValue(key: "service.name", value: OTLP.AnyValue(stringValue: "ondas")),
            OTLP.KeyValue(key: "service.version", value: OTLP.AnyValue(stringValue: serviceVersion)),
        ])
        let scope = OTLP.ScopeSpans(
            scope: OTLP.Scope(name: "ondas", version: serviceVersion),
            spans: spans.map(OTLP.Span.init)
        )
        let payload = OTLP.Payload(resourceSpans: [
            OTLP.ResourceSpans(resource: resource, scopeSpans: [scope]),
        ])
        return try JSONEncoder().encode(payload)
    }
}

/// OTLP/HTTP JSON wire types (encode-only). `intValue`/`unixNano` are strings because protobuf JSON
/// encodes 64-bit integers as strings; the coding-stats ingest accepts both forms.
private enum OTLP {
    struct Payload: Encodable {
        let resourceSpans: [ResourceSpans]
    }

    struct ResourceSpans: Encodable {
        let resource: Resource
        let scopeSpans: [ScopeSpans]
    }

    struct Resource: Encodable {
        let attributes: [KeyValue]
    }

    struct ScopeSpans: Encodable {
        let scope: Scope
        let spans: [Span]
    }

    struct Scope: Encodable {
        let name: String
        let version: String
    }

    struct Span: Encodable {
        let traceId: String
        let spanId: String
        let name: String
        let kind: Int
        let startTimeUnixNano: String
        let endTimeUnixNano: String
        let attributes: [KeyValue]

        init(_ span: TelemetrySpan) {
            traceId = span.traceIdHex
            spanId = span.spanIdHex
            name = span.name
            kind = 1 // SPAN_KIND_INTERNAL
            startTimeUnixNano = String(span.startUnixNano)
            endTimeUnixNano = String(span.endUnixNano)
            attributes = span.attributes.map(KeyValue.init)
        }
    }

    struct KeyValue: Encodable {
        let key: String
        let value: AnyValue

        init(key: String, value: AnyValue) {
            self.key = key
            self.value = value
        }

        init(_ attribute: TelemetrySpan.Attribute) {
            key = attribute.key
            switch attribute.value {
            case .string(let string):
                value = AnyValue(stringValue: string)
            case .int(let int):
                value = AnyValue(intValue: String(int))
            }
        }
    }

    struct AnyValue: Encodable {
        var stringValue: String?
        var intValue: String?

        private enum CodingKeys: String, CodingKey {
            case stringValue
            case intValue
        }

        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            if let stringValue { try container.encode(stringValue, forKey: .stringValue) }
            if let intValue { try container.encode(intValue, forKey: .intValue) }
        }
    }
}
