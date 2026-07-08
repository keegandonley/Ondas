import Foundation
import SwiftData

/// One message in a `Conversation`. Carries either text (chat replies) or a generated
/// image (`imageData`), or both. CloudKit-safe: every property is defaulted, the
/// relationship is optional, and there is no unique constraint.
@Model
final class ChatMessage {
    var id: UUID = UUID()

    /// Backing store for `role`. See `ChatRole`.
    var roleRaw: String = ChatRole.user.rawValue

    var text: String = ""

    /// On-device generated image, stored externally so SwiftData does not inline a large
    /// blob into the message row. JPEG-encoded (see `ImageGenerator`).
    @Attribute(.externalStorage)
    var imageData: Data? = nil

    var createdAt: Date = Date.now

    /// True when this assistant message carries an app-generated error/availability notice
    /// rather than real model output. Error turns are excluded from the rehydrated session
    /// transcript so the model never sees them as its own words. Defaulted for CloudKit.
    var isError: Bool = false

    /// True when this message is a compaction marker rather than a chat turn: its `text` holds a
    /// model-generated summary of everything before it, and the UI renders it as a "Conversation
    /// compacted" divider (see `CompactionDivider`), never as a bubble. On the model side the
    /// summary is folded into the rehydrated session's instructions while the turns above the
    /// marker stop feeding the model (see `Compaction` / `ChatEngine.makeTranscript`). Defaulted
    /// for CloudKit — see the Production-schema deploy caveat in the vault before shipping.
    var isCompactionSummary: Bool = false

    /// The owning thread. Optional and un-annotated here; the inverse and cascade delete
    /// rule live on `Conversation.messages`.
    var conversation: Conversation? = nil

    init(
        role: ChatRole,
        text: String = "",
        imageData: Data? = nil,
        createdAt: Date = .now
    ) {
        self.id = UUID()
        self.roleRaw = role.rawValue
        self.text = text
        self.imageData = imageData
        self.createdAt = createdAt
    }

    var role: ChatRole {
        get { ChatRole(rawValue: roleRaw) ?? .user }
        set { roleRaw = newValue.rawValue }
    }

    var hasImage: Bool {
        imageData != nil
    }

    /// True for a freshly-inserted assistant bubble that has no content yet — the state the
    /// UI renders as a "thinking" indicator while the model works.
    var isEmptyPlaceholder: Bool {
        role == .assistant && text.isEmpty && !hasImage && !isCompactionSummary
    }
}
