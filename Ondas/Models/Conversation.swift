import Foundation
import SwiftData

/// A single chat thread. The root aggregate that owns its messages.
///
/// Every stored property has a default value and no property is `@Attribute(.unique)`,
/// which are hard requirements for a CloudKit-backed SwiftData store (see
/// `AppModelContainer`).
@Model
final class Conversation {
    /// Stable identity used for view selection and navigation. Not `.unique` because
    /// CloudKit-backed stores forbid unique constraints; uniqueness is guaranteed by
    /// generating a fresh `UUID` per row instead.
    var id: UUID = UUID()

    var title: String = Conversation.defaultTitle
    var createdAt: Date = Date.now

    /// Bumped whenever a message is added so the conversation list can sort by recency.
    var updatedAt: Date = Date.now

    @Relationship(deleteRule: .cascade, inverse: \ChatMessage.conversation)
    var messages: [ChatMessage]? = []

    static let defaultTitle = "New Chat"

    /// Maximum number of messages a single conversation may hold. Once reached, the chat is
    /// closed to new input and the user is prompted to start a fresh chat. This is a hard cap
    /// (not a sliding window) so the model always sees the *entire* conversation, and it keeps
    /// the rehydrated transcript comfortably inside the on-device model's context window.
    /// A proxy for the token budget — tune down if long messages approach the limit.
    static let messageLimit = 40

    init(title: String = Conversation.defaultTitle, createdAt: Date = .now) {
        self.id = UUID()
        self.title = title
        self.createdAt = createdAt
        self.updatedAt = createdAt
    }

    /// Messages in chronological (display) order.
    var orderedMessages: [ChatMessage] {
        (messages ?? []).sorted { $0.createdAt < $1.createdAt }
    }

    /// The most recent message, used for the list-row preview.
    var latestMessage: ChatMessage? {
        orderedMessages.last
    }

    /// The most recent message in this thread that carries a generated image, or nil if it has none.
    /// Drives the list-row thumbnail so a glance at the sidebar reveals which chats produced images.
    var latestImageMessage: ChatMessage? {
        orderedMessages.last(where: { $0.hasImage })
    }

    var hasMessages: Bool {
        !(messages ?? []).isEmpty
    }

    /// True once the conversation has hit `messageLimit` and can no longer accept new turns.
    /// Error notices don't count: they're excluded from the rehydrated transcript (see
    /// `ChatEngine.makeTranscript`), so they consume none of the context budget this cap proxies —
    /// a run of failed turns must not close a chat early.
    var isAtCapacity: Bool {
        (messages ?? []).count(where: { !$0.isError }) >= Conversation.messageLimit
    }
}
