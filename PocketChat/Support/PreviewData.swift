import Foundation
import SwiftData

/// In-memory sample data for SwiftUI previews. Never touches CloudKit or the on-disk store.
@MainActor
enum PreviewData {
    static let container: ModelContainer = {
        let container = AppModelContainer.make(inMemory: true)
        seed(container.mainContext)
        return container
    }()

    /// The first seeded conversation, for previewing `ChatView`.
    static var sampleConversation: Conversation {
        let descriptor = FetchDescriptor<Conversation>(
            sortBy: [SortDescriptor(\.updatedAt, order: .reverse)]
        )
        let existing = (try? container.mainContext.fetch(descriptor))?.first
        return existing ?? Conversation(title: "Preview Chat")
    }

    private static func seed(_ context: ModelContext) {
        let conversation = Conversation(title: "Trip ideas")
        context.insert(conversation)

        let base = Date.now.addingTimeInterval(-600)
        let messages = [
            ChatMessage(role: .user, text: "What's a good weekend trip near the coast?", createdAt: base),
            ChatMessage(
                role: .assistant,
                text: "A coastal town like Mendocino is great — walkable, good food, and easy hikes along the bluffs.",
                createdAt: base.addingTimeInterval(4)
            ),
            ChatMessage(role: .user, text: "Draw a picture of a lighthouse there", createdAt: base.addingTimeInterval(30)),
        ]
        for message in messages {
            message.conversation = conversation
            context.insert(message)
        }

        let empty = Conversation(title: Conversation.defaultTitle)
        context.insert(empty)

        try? context.save()
    }
}
