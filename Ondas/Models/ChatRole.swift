import Foundation

/// Who authored a message in a conversation. Stored as a raw string on `ChatMessage`
/// (CloudKit-backed SwiftData requires defaulted scalar properties), and surfaced
/// through the typed `ChatMessage.role` accessor.
enum ChatRole: String, Codable, Sendable {
    case user
    case assistant
}
