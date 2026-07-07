import Foundation

extension String {
    /// True when the string is empty or only whitespace/newlines. Centralizes the
    /// "trim and check empty" pattern used by the composer and the chat engine.
    var isBlank: Bool {
        trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}
