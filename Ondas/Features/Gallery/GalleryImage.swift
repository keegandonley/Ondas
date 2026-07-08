import Foundation

/// A single entry in the Gallery, unifying the two places a generated image can come from:
/// a standalone `GeneratedImage` (no conversation) and a chat `ChatMessage` that carries image
/// bytes. The Gallery merges both into one newest-first stream.
struct GalleryImage: Identifiable, Equatable {
    /// Stable identity: the `GeneratedImage.id` or the `ChatMessage.id` the image came from.
    let id: UUID
    let imageData: Data
    let prompt: String
    let createdAt: Date

    /// The conversation this image was generated in, or nil for a standalone image. Drives whether
    /// the viewer offers "Open in chat".
    let sourceConversationID: UUID?

    // Compare by identity only — hashing/equating the image bytes would be needlessly expensive.
    static func == (lhs: GalleryImage, rhs: GalleryImage) -> Bool {
        lhs.id == rhs.id
    }
}

enum GalleryImageMerger {
    /// Merges standalone images and chat messages into one newest-first list. Chat messages
    /// without image bytes are skipped. Kept pure so the ordering is unit-testable.
    static func merge(
        standalone: [GeneratedImage],
        chatMessages: [ChatMessage]
    ) -> [GalleryImage] {
        var items: [GalleryImage] = []

        for image in standalone {
            guard let data = image.imageData else { continue }
            items.append(GalleryImage(
                id: image.id,
                imageData: data,
                prompt: image.prompt,
                createdAt: image.createdAt,
                sourceConversationID: nil
            ))
        }

        for message in chatMessages {
            guard let data = message.imageData else { continue }
            items.append(GalleryImage(
                id: message.id,
                imageData: data,
                // Chat images don't store a separate prompt; the request text sits in another
                // message, so leave it empty here.
                prompt: "",
                createdAt: message.createdAt,
                sourceConversationID: message.conversation?.id
            ))
        }

        return items.sorted { $0.createdAt > $1.createdAt }
    }
}
