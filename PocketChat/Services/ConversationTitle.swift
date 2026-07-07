import Foundation

/// Derives a short, human-readable conversation title from the first user message, so the
/// sidebar shows something meaningful without a separate model call.
enum ConversationTitle {
    /// Maximum characters in a derived title before it is truncated with an ellipsis.
    private static let maxLength = 40

    /// A single-line title built from `message`. Collapses whitespace, takes the first
    /// line, and truncates on a word boundary when possible. Returns the default title for
    /// empty input.
    static func derive(from message: String) -> String {
        let firstLine = message
            .split(whereSeparator: \.isNewline)
            .first
            .map(String.init) ?? ""
        let collapsed = firstLine
            .split(whereSeparator: \.isWhitespace)
            .joined(separator: " ")

        guard !collapsed.isEmpty else { return Conversation.defaultTitle }
        guard collapsed.count > maxLength else { return collapsed }

        let truncated = String(collapsed.prefix(maxLength))
        // Prefer cutting at the last space so a word is not split mid-way.
        if let lastSpace = truncated.lastIndex(of: " "),
           truncated.distance(from: truncated.startIndex, to: lastSpace) > maxLength / 2 {
            return truncated[..<lastSpace] + "…"
        }
        return truncated + "…"
    }
}
