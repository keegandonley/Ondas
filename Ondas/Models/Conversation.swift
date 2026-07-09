import Foundation
import SwiftData

extension Conversation {
    /// A one-line preview of the latest message for sidebar/list rows. Shared by the main
    /// conversation list and the menu-bar quick-chat panel so both read identically.
    var previewText: String {
        guard let latest = latestMessage else {
            return "No messages yet"
        }
        if latest.hasImage, latest.text.isEmpty {
            return latest.role == .user ? "Image request" : "Generated image"
        }
        return latest.text
    }

    /// Returns an existing empty ("New Chat") thread to reuse, or inserts and returns a fresh one.
    /// Centralizes the "don't accumulate empty CloudKit-synced rows on repeated New Chat taps"
    /// policy shared by the main list and the quick-chat panel. Callers select the returned thread.
    static func reuseEmptyOrCreate(
        from conversations: [Conversation],
        in context: ModelContext
    ) -> Conversation {
        if let empty = conversations.first(where: { !$0.hasMessages }) {
            return empty
        }
        let conversation = Conversation()
        context.insert(conversation)
        context.saveOrLog()
        return conversation
    }
}

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

    /// Message count at which the chat starts suggesting compaction — the message-count mirror of
    /// `TokenUsage.warningFraction`, used only on the fallback path when a token count is unavailable.
    /// Kept below `messageLimit` so the nudge arrives with room to summarize, not at the wall.
    static let compactionSuggestedCount = Int(Double(messageLimit) * TokenUsage.warningFraction)

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

    /// The most recent message, used for the list-row preview. Compaction markers are skipped so
    /// the sidebar shows a real turn, not a summary divider.
    var latestMessage: ChatMessage? {
        orderedMessages.last(where: { !$0.isCompactionSummary })
    }

    /// The most recent message in this thread that carries a generated image, or nil if it has none.
    /// Drives the list-row thumbnail so a glance at the sidebar reveals which chats produced images.
    var latestImageMessage: ChatMessage? {
        orderedMessages.last(where: { $0.hasImage })
    }

    var hasMessages: Bool {
        !(messages ?? []).isEmpty
    }

    /// Capacity standing from the message-count cap — the fallback used only when a token count is
    /// unavailable (a failed/undeterminable count); otherwise `ChatEngine.tokenUsage` is the primary
    /// defense. Only the turns since the last compaction count (see `Compaction.capacityCount`):
    /// compaction summarizes older turns into a divider and continues in place, so a compacted chat
    /// must not stay stuck at capacity. Error notices are excluded too — they're kept out of the
    /// rehydrated transcript, so they consume none of the context budget this cap proxies.
    var capacityState: CapacityState {
        let count = Compaction.capacityCount(in: orderedMessages)
        if count >= Conversation.messageLimit { return .full }
        if count >= Conversation.compactionSuggestedCount { return .approaching }
        return .normal
    }
}
