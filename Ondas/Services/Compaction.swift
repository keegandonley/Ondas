import Foundation

/// Pure helpers for conversation compaction — the "Continue" flow that summarizes a full chat
/// into a divider and keeps going in the *same* conversation (same `id`, so OTLP `session.id`
/// stays continuous). These operate on a conversation's already-ordered message list and hold no
/// model or SwiftData dependencies, so they're unit-testable without the on-device model.
///
/// Model of a compacted conversation: a compaction marker (`ChatMessage.isCompactionSummary`)
/// carries a summary of everything before it and is appended at the end of the chat when the user
/// taps Continue. So the marker renders as a divider right at the seam: every turn above it is
/// summarized history (still on screen, but no longer fed to the model), and the chat resumes below
/// it. The model continues from the summary alone — no verbatim tail is kept — which keeps the
/// divider legible at the bottom and the reduction unambiguous.
enum Compaction {
    /// Index of the most recent compaction marker in an ordered message list, or nil when the
    /// conversation has never been compacted.
    static func lastMarkerIndex(in ordered: [ChatMessage]) -> Int? {
        ordered.lastIndex(where: \.isCompactionSummary)
    }

    /// The active summary (the last marker's text), or nil when uncompacted.
    static func activeSummary(in ordered: [ChatMessage]) -> String? {
        lastMarkerIndex(in: ordered).map { ordered[$0].text }
    }

    /// The real (non-error, non-marker) turns after the last marker — all real turns when
    /// uncompacted. This is exactly what still feeds the model, and what the capacity budget grows
    /// against, so a compaction empties it and the chat is no longer stuck at capacity. It's also
    /// the set summarized by the next compaction.
    static func liveMessages(in ordered: [ChatMessage]) -> [ChatMessage] {
        let start = lastMarkerIndex(in: ordered).map { $0 + 1 } ?? 0
        return ordered[start...].filter(isRealTurn)
    }

    /// The message count the capacity fallback compares against `Conversation.messageLimit`: the
    /// live turns since the last compaction. (Token counting is the primary budget on iOS 26.4+.)
    static func capacityCount(in ordered: [ChatMessage]) -> Int {
        liveMessages(in: ordered).count
    }

    /// A real chat turn: neither an app-generated error notice nor a compaction marker. Both are
    /// excluded from everything the model sees and from the capacity budget.
    private static func isRealTurn(_ message: ChatMessage) -> Bool {
        !message.isError && !message.isCompactionSummary
    }
}
